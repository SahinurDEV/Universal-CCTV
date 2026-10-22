import "dotenv/config";
import { Queue, Worker, type Job } from "bullmq";
import { loadEnv } from "./env.js";
import { redis } from "./lib/redis.js";
import { prisma } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { drainPendingSegments } from "./recording/ingest.js";
import { enforceRetention } from "./recording/retention.js";
import { checkCameraHealth, checkStorageQuotaWarnings } from "./recording/health.js";
import { reconcileOrphanedObjects } from "./recording/reconciliation.js";
import { notifyOnce } from "./lib/notifications.js";
import { checkMotionForAllCameras } from "./recording/motion.js";

const env = loadEnv();

const QUEUE_NAME = "recording-ingestion";
const POLL_INTERVAL_MS = 15_000;
// Shorter than a real production interval would need (retention doesn't
// need minute-level responsiveness) — kept short here so it's actually
// observable in local dev/testing without an artificial wait.
const RETENTION_INTERVAL_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
// Same tradeoff as above — a real deployment has no need to scan the whole
// bucket this often; short here purely for dev-loop observability.
const RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const MOTION_INTERVAL_MS = env.MOTION_CHECK_INTERVAL_SECONDS * 1000;
// Motion sampling holds ffmpeg processes for several seconds; it gets its
// own queue so it never delays recording ingestion.
const MOTION_QUEUE_NAME = "motion-detection";
const motionQueue = new Queue(MOTION_QUEUE_NAME, { connection: redis });

const queue = new Queue(QUEUE_NAME, { connection: redis });

/**
 * Ingests completed segments for every actively-recording camera. Runs on a
 * fixed interval rather than being triggered by MediaMTX, because MediaMTX
 * has no "segment finished" webhook — polling its recordings list is the
 * mechanism it actually offers (see docs/video-recording.md).
 *
 * `includeLast: false` is critical here — see recording/ingest.ts — this is
 * the periodic path, not the stop-triggered drain, so the most recent
 * segment per camera may still be actively being written and must be left
 * alone until a newer one appears.
 */
async function pollActiveRecordings(): Promise<void> {
  const activeJobs = await prisma.recordingJob.findMany({
    where: { status: "RUNNING" },
    include: { camera: { select: { name: true } } },
  });

  for (const job of activeJobs) {
    try {
      const result = await drainPendingSegments(
        { tenantId: job.tenantId, cameraId: job.cameraId, jobId: job.id, segmentSeconds: job.segmentSeconds },
        { includeLast: false },
      );
      if (result.ingested > 0 || result.failed > 0) {
        logger.info({ cameraId: job.cameraId, jobId: job.id, ...result }, "recording ingestion poll");
      }
      if (result.failed > 0) {
        await prisma.recordingJob.update({
          where: { id: job.id },
          data: { lastError: `${result.failed} segment(s) failed to ingest on last poll; see server logs.` },
        });
        await notifyOnce({
          tenantId: job.tenantId,
          type: "UPLOAD_FAILURE",
          targetId: job.cameraId,
          message: `${result.failed} recording segment(s) for "${job.camera.name}" failed to upload.`,
          cooldownMinutes: 30,
        });
      }
    } catch (err) {
      logger.error({ err, cameraId: job.cameraId, jobId: job.id }, "recording ingestion poll failed for camera");
    }
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === "poll") {
      await pollActiveRecordings();
    } else if (job.name === "retention") {
      const result = await enforceRetention();
      if (result.markedExpired > 0 || result.deleted > 0 || result.failed > 0) {
        logger.info(result, "retention enforcement run");
      }
      // Tenant-wide, not per-camera — a failed delete isn't attributed to a
      // single target here, see recording/retention.ts. Notify exactly the
      // tenants that actually had a failure this run, not every tenant
      // with any lingering EXPIRED segment.
      for (const tenantId of result.failedTenantIds) {
        await notifyOnce({
          tenantId,
          type: "RETENTION_CLEANUP_FAILURE",
          targetId: null,
          message: "Some expired recordings failed to delete and will be retried automatically.",
          cooldownMinutes: 60,
        });
      }
    } else if (job.name === "health-check") {
      const healthResult = await checkCameraHealth();
      if (healthResult.offline > 0 || healthResult.stoppedUnexpectedly > 0) {
        logger.info(healthResult, "camera health check run");
      }
      await checkStorageQuotaWarnings();
    } else if (job.name === "reconcile-storage") {
      const result = await reconcileOrphanedObjects();
      if (result.orphaned > 0 || result.failed > 0) {
        logger.info(result, "storage reconciliation run");
      }
    }
  },
  { connection: redis },
);

const motionWorker = new Worker(
  MOTION_QUEUE_NAME,
  async () => {
    const result = await checkMotionForAllCameras();
    if (result.detected > 0 || result.failed > 0) logger.info(result, "motion check run");
  },
  { connection: redis },
);
motionWorker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, "motion worker job failed");
});

worker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, "recording-ingestion worker job failed");
});

async function start() {
  await queue.add("poll", {}, { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-recordings" });
  await queue.add("retention", {}, { repeat: { every: RETENTION_INTERVAL_MS }, jobId: "enforce-retention" });
  await queue.add("health-check", {}, { repeat: { every: HEALTH_CHECK_INTERVAL_MS }, jobId: "camera-health-check" });
  await queue.add("reconcile-storage", {}, { repeat: { every: RECONCILIATION_INTERVAL_MS }, jobId: "reconcile-storage" });
  await motionQueue.add("motion-check", {}, { repeat: { every: MOTION_INTERVAL_MS }, jobId: "motion-check" });
  logger.info(
    {
      motionIntervalMs: MOTION_INTERVAL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      retentionIntervalMs: RETENTION_INTERVAL_MS,
      healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
      reconciliationIntervalMs: RECONCILIATION_INTERVAL_MS,
    },
    "recording ingestion worker started",
  );
}

start().catch((err) => {
  logger.error({ err }, "failed to start recording ingestion worker");
  process.exitCode = 1;
});

async function shutdown() {
  await worker.close();
  await motionWorker.close();
  await queue.close();
  await motionQueue.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Defense-in-depth, not the primary mechanism: BullMQ already catches a job
// processor's rejected promise internally (surfaced via the "failed" handler
// above) and `pollActiveRecordings`'s per-camera try/catch already isolates
// one camera's failure from the others in the same poll. This exists for
// anything outside both of those paths.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection in worker — see docs/failure-recovery.md");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaught exception in worker — exiting for a clean restart");
  process.exit(1);
});
