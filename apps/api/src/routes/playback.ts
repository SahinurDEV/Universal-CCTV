import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { getSignedPlaybackUrl } from "../lib/storage.js";
import { writeAuditLog } from "../lib/audit.js";
import { loadEnv } from "../env.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const playbackRouter = Router();

playbackRouter.use(requireAuth, requireTenant);

async function findOwnedCamera(cameraId: string, tenantId: string) {
  return prisma.camera.findFirst({ where: { id: cameraId, tenantId }, select: { id: true, name: true } });
}

/**
 * Which UTC calendar dates actually have a completed recording for this
 * camera — the date picker should only ever offer dates with real data, not
 * make the user guess and hit an empty day. Matches the UTC-date grouping
 * `buildRecordingObjectKey` already uses for the S3 key scheme.
 */
playbackRouter.get("/:id/recordings/dates", asyncHandler(async (req, res) => {
  const camera = await findOwnedCamera(req.params.id!, req.authTenant!.id);
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const rows = await prisma.$queryRaw<{ date: Date }[]>`
    SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS date
    FROM recording_segments
    WHERE camera_id = ${camera.id} AND tenant_id = ${req.authTenant!.id} AND status = 'COMPLETE'
    ORDER BY date DESC
  `;

  res.json({ dates: rows.map((r) => r.date.toISOString().slice(0, 10)) });
}));

const listQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

playbackRouter.get("/:id/recordings", asyncHandler(async (req, res) => {
  const camera = await findOwnedCamera(req.params.id!, req.authTenant!.id);
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const dayStart = new Date(`${parsed.data.date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const segments = await prisma.recordingSegment.findMany({
    where: {
      cameraId: camera.id,
      tenantId: req.authTenant!.id,
      startedAt: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      fileSizeBytes: true,
      status: true,
    },
  });

  res.json({
    segments: segments.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationSec: s.durationSec,
      fileSizeBytes: s.fileSizeBytes?.toString() ?? null,
      status: s.status,
    })),
  });
}));

const urlQuerySchema = z.object({
  download: z.coerce.boolean().optional().default(false),
});

playbackRouter.get("/:id/recordings/:segmentId/url", asyncHandler(async (req, res) => {
  const camera = await findOwnedCamera(req.params.id!, req.authTenant!.id);
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const parsed = urlQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const segment = await prisma.recordingSegment.findFirst({
    where: { id: req.params.segmentId, cameraId: camera.id, tenantId: req.authTenant!.id, status: "COMPLETE" },
  });
  // Also 404 for a segment that exists but isn't COMPLETE (e.g. still
  // RECORDING, or UPLOAD_FAILED) — there is nothing valid to play yet,
  // same as if it didn't exist.
  if (!segment) {
    return res.status(404).json({ error: "not_found" });
  }

  const filename = `${camera.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${segment.startedAt.toISOString().replace(/[:.]/g, "-")}.mp4`;
  const url = await getSignedPlaybackUrl(segment.objectKey, parsed.data.download ? { downloadFilename: filename } : undefined);

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: parsed.data.download ? "recording.download" : "recording.play",
    targetType: "RecordingSegment",
    targetId: segment.id,
    metadata: { cameraId: camera.id },
  });

  res.json({ url, expiresInSeconds: loadEnv().SIGNED_URL_TTL_SECONDS });
}));
