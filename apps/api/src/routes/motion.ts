import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { loadEnv } from "../env.js";
import { MAX_SENSITIVITY, MIN_SENSITIVITY, sensitivityToThreshold } from "../lib/motion.js";
import { ALERT_CLASSES, activeModel } from "../lib/detector.js";
import { Prisma } from "@prisma/client";
import { parseZones, zonesSchema } from "../lib/zones.js";
import { alertScheduleSchema, isAlertActive, parseSchedule } from "../lib/schedule.js";
import { probeRateLimiter } from "../middleware/rateLimit.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, mediamtxPathName } from "../connectors/mediamtx-client.js";
import { captureJpeg } from "../lib/snapshot.js";
import { getSignedPlaybackUrl } from "../lib/storage.js";

/**
 * Motion detection settings and history.
 *   GET  /cameras/:id/motion          settings + last check status (any role)
 *   PUT  /cameras/:id/motion          enable/disable + sensitivity (OWNER/ADMIN/OPERATOR)
 *   GET  /cameras/:id/motion/events   recent detections for one camera
 *   GET  /motion-events               recent detections across the workspace
 * Other tenants' cameras always 404.
 */
export const cameraMotionRouter = Router();
export const motionEventsRouter = Router();
// Auth is per-route (not router.use) so other /cameras requests passing
// through this router don't pay for a second session lookup.
const auth = [requireAuth, requireTenant];
motionEventsRouter.use(requireAuth, requireTenant);

const idSchema = z.string().uuid();
const settingsSchema = z.object({
  enabled: z.boolean(),
  sensitivity: z.number().int().min(MIN_SENSITIVITY).max(MAX_SENSITIVITY).optional(),
  alertClasses: z.array(z.enum(ALERT_CLASSES)).min(1).max(ALERT_CLASSES.length).optional(),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cameraId: z.string().uuid().optional(),
});

function serializeSettings(c: {
  id: string;
  motionEnabled: boolean;
  motionSensitivity: number;
  motionAlertClasses: string[];
  motionLastCheckedAt: Date | null;
  motionLastError: string | null;
}) {
  return {
    cameraId: c.id,
    enabled: c.motionEnabled,
    sensitivity: c.motionSensitivity,
    threshold: sensitivityToThreshold(c.motionSensitivity),
    alertClasses: c.motionAlertClasses,
    lastCheckedAt: c.motionLastCheckedAt,
    lastError: c.motionLastError,
  };
}

function serializeEvent(
  e: { id: string; cameraId: string; score: number; threshold: number; detectedAt: Date; labels: unknown; snapshotKey: string | null },
  cameraName: string,
) {
  return {
    id: e.id,
    cameraId: e.cameraId,
    cameraName,
    score: e.score,
    threshold: e.threshold,
    detectedAt: e.detectedAt,
    labels: Array.isArray(e.labels) ? (e.labels as { label: string; category: string; score: number }[]) : null,
    hasSnapshot: Boolean(e.snapshotKey),
  };
}

async function findCamera(tenantId: string, rawId: string | undefined) {
  const id = idSchema.safeParse(rawId);
  if (!id.success) return null;
  return prisma.camera.findFirst({ where: { id: id.data, tenantId } });
}

cameraMotionRouter.get("/:id/motion", ...auth, asyncHandler(async (req, res) => {
  const camera = await findCamera(req.authTenant!.id, req.params.id);
  if (!camera) return res.status(404).json({ error: "not_found" });
  res.json(serializeSettings(camera));
}));

cameraMotionRouter.put("/:id/motion", ...auth, requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const camera = await findCamera(req.authTenant!.id, req.params.id);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const updated = await prisma.camera.update({
    where: { id: camera.id },
    data: {
      motionEnabled: parsed.data.enabled,
      ...(parsed.data.sensitivity !== undefined ? { motionSensitivity: parsed.data.sensitivity } : {}),
      ...(parsed.data.alertClasses ? { motionAlertClasses: [...new Set(parsed.data.alertClasses)] } : {}),
      ...(parsed.data.enabled ? {} : { motionLastError: null }),
    },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.motion.update",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { enabled: updated.motionEnabled, sensitivity: updated.motionSensitivity, alertClasses: updated.motionAlertClasses },
  });
  res.json(serializeSettings(updated));
}));

cameraMotionRouter.get("/:id/motion/events", ...auth, asyncHandler(async (req, res) => {
  const camera = await findCamera(req.authTenant!.id, req.params.id);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const events = await prisma.motionEvent.findMany({
    where: { tenantId: req.authTenant!.id, cameraId: camera.id },
    orderBy: { detectedAt: "desc" },
    take: q.data.limit,
  });
  res.json({
    events: events.map((e) => serializeEvent(e, camera.name)),
  });
}));

motionEventsRouter.get("/", asyncHandler(async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const events = await prisma.motionEvent.findMany({
    where: { tenantId: req.authTenant!.id, ...(q.data.cameraId ? { cameraId: q.data.cameraId } : {}) },
    include: { camera: { select: { name: true } } },
    orderBy: { detectedAt: "desc" },
    take: q.data.limit,
  });
  res.json({
    events: events.map((e) => serializeEvent(e, e.camera.name)),
  });
}));

/** Short-lived signed URL for an event's snapshot JPEG (any role, own tenant). */
motionEventsRouter.get("/:id/snapshot", asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const event = await prisma.motionEvent.findFirst({ where: { id: id.data, tenantId: req.authTenant!.id } });
  if (!event?.snapshotKey) return res.status(404).json({ error: "not_found" });
  res.json({ url: await getSignedPlaybackUrl(event.snapshotKey), expiresInSeconds: loadEnv().SIGNED_URL_TTL_SECONDS });
}));

// ---------------------------------------------------------------- detection config

const thresholdsSchema = z
  .object({
    person: z.number().min(0.2).max(0.95).optional(),
    vehicle: z.number().min(0.2).max(0.95).optional(),
  })
  .strict();
const detectionSchema = z
  .object({
    zones: zonesSchema.optional(),
    schedule: alertScheduleSchema.nullable().optional(),
    thresholds: thresholdsSchema.nullable().optional(),
  })
  .strict();

function serializeDetection(
  c: { id: string; detectionZones: unknown; alertSchedule: unknown; detectionThresholds: unknown },
  timezone: string,
) {
  const env = loadEnv();
  const model = activeModel();
  const schedule = parseSchedule(c.alertSchedule);
  return {
    cameraId: c.id,
    zones: parseZones(c.detectionZones),
    schedule,
    thresholds: (c.detectionThresholds ?? {}) as Record<string, number>,
    defaultThreshold: env.DETECTION_MIN_SCORE,
    timezone,
    alertsActiveNow: isAlertActive(schedule, new Date(), timezone),
    model: { id: model.id, name: model.name, license: model.license, enabled: env.DETECTION_ENABLED },
  };
}

/** Zones, schedule and per-class thresholds (any role can read). */
cameraMotionRouter.get("/:id/detection", ...auth, asyncHandler(async (req, res) => {
  const camera = await findCamera(req.authTenant!.id, req.params.id);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.authTenant!.id }, select: { timezone: true } });
  res.json(serializeDetection(camera, tenant.timezone));
}));

cameraMotionRouter.put("/:id/detection", ...auth, requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const camera = await findCamera(req.authTenant!.id, req.params.id);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const parsed = detectionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const { zones, schedule, thresholds } = parsed.data;
  if (zones && new Set(zones.map((z) => z.id)).size !== zones.length) {
    return res.status(400).json({ error: "invalid_request", message: "Zone ids must be unique." });
  }
  const updated = await prisma.camera.update({
    where: { id: camera.id },
    data: {
      ...(zones !== undefined ? { detectionZones: zones.length ? zones : Prisma.DbNull } : {}),
      ...(schedule !== undefined ? { alertSchedule: schedule ?? Prisma.DbNull } : {}),
      ...(thresholds !== undefined ? { detectionThresholds: thresholds && Object.keys(thresholds).length ? thresholds : Prisma.DbNull } : {}),
    },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.detection.update",
    targetType: "Camera",
    targetId: camera.id,
    metadata: {
      zones: parseZones(updated.detectionZones).length,
      scheduleEnabled: parseSchedule(updated.alertSchedule)?.enabled ?? false,
      thresholds: (updated.detectionThresholds ?? {}) as Prisma.InputJsonValue,
    },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.authTenant!.id }, select: { timezone: true } });
  res.json(serializeDetection(updated, tenant.timezone));
}));

/** A fresh JPEG from the camera (for drawing zones). Any role; rate-limited
 * because it makes the server pull a frame from the camera. */
cameraMotionRouter.get("/:id/snapshot.jpg", ...auth, probeRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const camera = await prisma.camera.findFirst({ where: { id: id.data, tenantId: req.authTenant!.id }, include: { credential: true } });
  if (!camera) return res.status(404).json({ error: "not_found" });
  const source = await resolveCameraRtspUrl(camera);
  if (!source.ok) return res.status(source.status).json({ error: source.error, message: source.message });
  try {
    await ensureLivePath(camera.id, source.rtspUrl);
    const relayUrl = `${loadEnv().MEDIAMTX_RTSP_URL.replace(/\/$/, "")}/${mediamtxPathName(camera.id)}`;
    const jpeg = await captureJpeg(relayUrl);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(jpeg);
  } catch {
    res.status(502).json({ error: "snapshot_unavailable", message: "Could not grab a frame from this camera." });
  }
}));
