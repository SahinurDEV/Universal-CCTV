import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { writeAuditLog } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { addRecordingPath, stopRecordingPath, removeRecordingPath } from "../connectors/mediamtx-client.js";
import { drainPendingSegments } from "../recording/ingest.js";
import { getActiveSubscription, getStorageBytesUsed } from "../lib/quota.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const recordingRouter = Router();

recordingRouter.use(requireAuth, requireTenant);

const startSchema = z.object({
  segmentSeconds: z.coerce.number().int().min(10).max(300).default(60),
});

recordingRouter.get("/:id/recording", asyncHandler(async (req, res) => {
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
    select: { id: true },
  });
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const job = await prisma.recordingJob.findFirst({
    where: { cameraId: camera.id, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  });

  const segmentCount = job
    ? await prisma.recordingSegment.count({ where: { jobId: job.id } })
    : 0;

  res.json({
    active: job != null,
    jobId: job?.id ?? null,
    status: job?.status ?? null,
    startedAt: job?.startedAt ?? null,
    segmentSeconds: job?.segmentSeconds ?? null,
    segmentCount,
  });
}));

recordingRouter.post("/:id/recording/start", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
    include: { credential: true },
  });
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const existingActive = await prisma.recordingJob.findFirst({
    where: { cameraId: camera.id, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (existingActive) {
    return res.status(409).json({ error: "recording_already_active", jobId: existingActive.id });
  }

  // Enforced at recording *start*, per docs/requirements.md §9 ("storage
  // quota... enforced before new recording jobs start") — not mid-recording,
  // which would mean killing an in-progress job partway through.
  const subscription = await getActiveSubscription(req.authTenant!.id);
  if (subscription) {
    const storageBytesUsed = await getStorageBytesUsed(req.authTenant!.id);
    const quotaBytes = BigInt(subscription.plan.storageQuotaGb) * 1024n * 1024n * 1024n;
    if (storageBytesUsed >= quotaBytes) {
      return res.status(402).json({
        error: "storage_quota_exceeded",
        message: `Your ${subscription.plan.name} plan's ${subscription.plan.storageQuotaGb}GB storage quota is full.`,
      });
    }
  }

  const source = await resolveCameraRtspUrl(camera);
  if (!source.ok) {
    return res.status(source.status).json({ error: source.error, message: source.message });
  }
  const rtspUrl = source.rtspUrl;

  try {
    await addRecordingPath(camera.id, rtspUrl, { segmentDurationSeconds: parsed.data.segmentSeconds });
  } catch (err) {
    logger.error({ err, cameraId: camera.id }, "failed to start recording");
    return res.status(502).json({ error: "recording_start_failed" });
  }

  const job = await prisma.recordingJob.create({
    data: {
      cameraId: camera.id,
      tenantId: req.authTenant!.id,
      status: "RUNNING",
      segmentSeconds: parsed.data.segmentSeconds,
      startedAt: new Date(),
    },
  });

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "recording.start",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { jobId: job.id, segmentSeconds: parsed.data.segmentSeconds },
  });

  res.status(201).json({ jobId: job.id, status: job.status, startedAt: job.startedAt });
}));

recordingRouter.post("/:id/recording/stop", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
  });
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  const job = await prisma.recordingJob.findFirst({
    where: { cameraId: camera.id, status: "RUNNING" },
  });
  if (!job) {
    return res.status(404).json({ error: "no_active_recording" });
  }

  // Order matters: patch record=false BEFORE draining (finalizes the
  // in-progress segment so it's safe to ingest), drain BEFORE removing the
  // path (removing the path deletes any not-yet-ingested segments — see
  // removeRecordingPath's warning).
  let drainResult: { ingested: number; failed: number };
  try {
    await stopRecordingPath(camera.id);
    drainResult = await drainPendingSegments(
      { tenantId: req.authTenant!.id, cameraId: camera.id, jobId: job.id, segmentSeconds: job.segmentSeconds },
      { includeLast: true },
    );
    await removeRecordingPath(camera.id);
  } catch (err) {
    logger.error({ err, cameraId: camera.id, jobId: job.id }, "failed to cleanly stop recording");
    await prisma.recordingJob.update({
      where: { id: job.id },
      data: { status: "FAILED", lastError: "Failed to stop cleanly; see server logs.", stoppedAt: new Date() },
    });
    return res.status(502).json({ error: "recording_stop_failed" });
  }

  await prisma.recordingJob.update({
    where: { id: job.id },
    data: { status: "STOPPED", stoppedAt: new Date() },
  });

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "recording.stop",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { jobId: job.id, ...drainResult },
  });

  res.json({ jobId: job.id, status: "STOPPED", ...drainResult });
}));
