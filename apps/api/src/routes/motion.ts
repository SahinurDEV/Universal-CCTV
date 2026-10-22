import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { MAX_SENSITIVITY, MIN_SENSITIVITY, sensitivityToThreshold } from "../lib/motion.js";

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
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cameraId: z.string().uuid().optional(),
});

function serializeSettings(c: {
  id: string;
  motionEnabled: boolean;
  motionSensitivity: number;
  motionLastCheckedAt: Date | null;
  motionLastError: string | null;
}) {
  return {
    cameraId: c.id,
    enabled: c.motionEnabled,
    sensitivity: c.motionSensitivity,
    threshold: sensitivityToThreshold(c.motionSensitivity),
    lastCheckedAt: c.motionLastCheckedAt,
    lastError: c.motionLastError,
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
      ...(parsed.data.enabled ? {} : { motionLastError: null }),
    },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.motion.update",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { enabled: updated.motionEnabled, sensitivity: updated.motionSensitivity },
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
    events: events.map((e) => ({ id: e.id, cameraId: e.cameraId, cameraName: camera.name, score: e.score, threshold: e.threshold, detectedAt: e.detectedAt })),
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
    events: events.map((e) => ({ id: e.id, cameraId: e.cameraId, cameraName: e.camera.name, score: e.score, threshold: e.threshold, detectedAt: e.detectedAt })),
  });
}));
