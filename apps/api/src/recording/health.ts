import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { listAllPathStatuses, mediamtxPathName } from "../connectors/mediamtx-client.js";
import { notifyOnce } from "../lib/notifications.js";
import { getStorageBytesUsed } from "../lib/quota.js";

const OFFLINE_NOTIFICATION_COOLDOWN_MINUTES = 30;
const STORAGE_WARNING_COOLDOWN_MINUTES = 24 * 60;
const STORAGE_WARNING_THRESHOLD = 0.8;

export interface HealthCheckResult {
  checked: number;
  offline: number;
  stoppedUnexpectedly: number;
}

/**
 * For every actively-recording camera, asks MediaMTX whether its source
 * connection is actually up right now (`getPathStatus`) and notifies on two
 * distinct conditions, per docs/requirements.md §17:
 *   - CAMERA_OFFLINE: the path still exists (MediaMTX is still trying,
 *     retrying its own RTSP pull internally) but isn't currently connected.
 *     The recording job stays RUNNING — MediaMTX will resume recording on
 *     its own once the camera comes back, nothing for us to restart.
 *   - RECORDING_STOPPED: the path doesn't exist at all anymore, meaning
 *     something removed it outside the normal stop flow (a crash, manual
 *     MediaMTX intervention, etc). The DB still says RUNNING but nothing is
 *     actually being recorded — this job is marked FAILED rather than left
 *     lying about its own state.
 * `notifyOnce`'s cooldown is what prevents a camera that's offline for an
 * hour of 30s polls from generating dozens of identical notifications.
 */
export async function checkCameraHealth(): Promise<HealthCheckResult> {
  const activeJobs = await prisma.recordingJob.findMany({
    where: { status: "RUNNING" },
    include: { camera: { select: { name: true } } },
  });

  let offline = 0;
  let stoppedUnexpectedly = 0;

  // One HTTP round trip to MediaMTX for every active job, not N — see
  // `listAllPathStatuses`'s own comment for why this matters at scale. If
  // this single call fails (MediaMTX itself unreachable), we must NOT fall
  // through into the loop below with an empty map — every job's lookup
  // would then resolve to "path missing" and get mass-marked FAILED, which
  // would be a false positive affecting every camera at once instead of
  // the previous per-camera isolation. Skip the whole cycle instead; the
  // next one will pick it back up once MediaMTX is reachable again.
  let pathStatuses: Map<string, { ready: boolean }>;
  try {
    pathStatuses = activeJobs.length > 0 ? await listAllPathStatuses() : new Map();
  } catch (err) {
    logger.error({ err }, "camera health check: failed to list path statuses from MediaMTX; skipping this cycle");
    return { checked: activeJobs.length, offline: 0, stoppedUnexpectedly: 0 };
  }

  for (const job of activeJobs) {
    try {
      const status = pathStatuses.get(mediamtxPathName(job.cameraId)) ?? null;

      if (status === null) {
        stoppedUnexpectedly++;
        await prisma.recordingJob.update({
          where: { id: job.id },
          data: { status: "FAILED", lastError: "MediaMTX path disappeared outside the normal stop flow.", stoppedAt: new Date() },
        });
        await notifyOnce({
          tenantId: job.tenantId,
          type: "RECORDING_STOPPED",
          targetId: job.cameraId,
          message: `Recording for "${job.camera.name}" stopped unexpectedly.`,
          cooldownMinutes: OFFLINE_NOTIFICATION_COOLDOWN_MINUTES,
        });
      } else if (!status.ready) {
        offline++;
        await notifyOnce({
          tenantId: job.tenantId,
          type: "CAMERA_OFFLINE",
          targetId: job.cameraId,
          message: `"${job.camera.name}" appears to be offline — MediaMTX is retrying the connection.`,
          cooldownMinutes: OFFLINE_NOTIFICATION_COOLDOWN_MINUTES,
        });
      }
    } catch (err) {
      logger.error({ err, cameraId: job.cameraId, jobId: job.id }, "camera health check failed for camera");
    }
  }

  return { checked: activeJobs.length, offline, stoppedUnexpectedly };
}

/**
 * Warns a tenant once their real storage usage crosses 80% of their plan's
 * quota — a long (24h) cooldown since this is a slow-moving condition, not
 * an emergency to repeat every poll.
 */
export async function checkStorageQuotaWarnings(): Promise<{ warned: number }> {
  const subscriptions = await prisma.subscription.findMany({ include: { plan: true } });
  let warned = 0;

  for (const subscription of subscriptions) {
    try {
      const used = await getStorageBytesUsed(subscription.tenantId);
      const quotaBytes = BigInt(subscription.plan.storageQuotaGb) * 1024n * 1024n * 1024n;
      if (quotaBytes === 0n) continue;

      const ratio = Number(used) / Number(quotaBytes);
      if (ratio >= STORAGE_WARNING_THRESHOLD) {
        const notified = await notifyOnce({
          tenantId: subscription.tenantId,
          type: "STORAGE_QUOTA_WARNING",
          targetId: null,
          message: `Storage usage is at ${Math.round(ratio * 100)}% of your ${subscription.plan.name} plan's ${subscription.plan.storageQuotaGb}GB quota.`,
          cooldownMinutes: STORAGE_WARNING_COOLDOWN_MINUTES,
        });
        if (notified) warned++;
      }
    } catch (err) {
      logger.error({ err, tenantId: subscription.tenantId }, "storage quota warning check failed for tenant");
    }
  }

  return { warned };
}
