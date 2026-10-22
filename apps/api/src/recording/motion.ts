import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, mediamtxPathName } from "../connectors/mediamtx-client.js";
import { sampleMotion, sensitivityToThreshold, type MotionSampleResult } from "../lib/motion.js";
import { notifyOnce } from "../lib/notifications.js";

const CONCURRENCY = 4;

export interface MotionCheckResult {
  checked: number;
  detected: number;
  failed: number;
}

type Sampler = (rtspUrl: string, seconds: number) => Promise<MotionSampleResult>;

/** Records a detection: always a MotionEvent row, plus a MOTION_DETECTED
 * alert (in-app + webhooks) at most once per cooldown window per camera. */
export async function recordMotion(camera: { id: string; tenantId: string; name: string }, score: number, threshold: number) {
  const env = loadEnv();
  const event = await prisma.motionEvent.create({
    data: { tenantId: camera.tenantId, cameraId: camera.id, score, threshold },
  });
  const alerted = await notifyOnce({
    tenantId: camera.tenantId,
    type: "MOTION_DETECTED",
    targetId: camera.id,
    message: `Motion detected on "${camera.name}".`,
    cooldownMinutes: env.MOTION_ALERT_COOLDOWN_MINUTES,
  });
  return { event, alerted };
}

/** One pass over every motion-enabled camera. Each camera is read through
 * its MediaMTX path (shared with live view/recording), so the camera itself
 * gets no extra connection. One camera failing never affects the others. */
export async function checkMotionForAllCameras(sampler: Sampler = sampleMotion): Promise<MotionCheckResult> {
  const env = loadEnv();
  const cameras = await prisma.camera.findMany({
    where: { motionEnabled: true },
    include: { credential: true },
  });
  const result: MotionCheckResult = { checked: 0, detected: 0, failed: 0 };

  const queue = [...cameras];
  async function runOne() {
    for (let camera = queue.shift(); camera; camera = queue.shift()) {
      let lastError: string | null = null;
      try {
        const source = await resolveCameraRtspUrl(camera);
        if (!source.ok) throw new Error(source.message ?? source.error);
        await ensureLivePath(camera.id, source.rtspUrl);
        const relayUrl = `${env.MEDIAMTX_RTSP_URL.replace(/\/$/, "")}/${mediamtxPathName(camera.id)}`;
        const sample = await sampler(relayUrl, env.MOTION_SAMPLE_SECONDS);
        const threshold = sensitivityToThreshold(camera.motionSensitivity);
        result.checked++;
        if (sample.maxScore >= threshold) {
          await recordMotion(camera, sample.maxScore, threshold);
          result.detected++;
        }
      } catch (err) {
        result.failed++;
        lastError = err instanceof Error ? err.message.slice(0, 300) : "motion check failed";
        logger.warn({ cameraId: camera.id, error: lastError }, "motion check failed");
      }
      await prisma.camera
        .update({ where: { id: camera.id }, data: { motionLastCheckedAt: new Date(), motionLastError: lastError } })
        .catch(() => undefined);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cameras.length) }, runOne));
  return result;
}
