import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, mediamtxPathName } from "../connectors/mediamtx-client.js";
import { sampleMotion, sensitivityToThreshold, type MotionSampleResult } from "../lib/motion.js";
import { notifyOnce } from "../lib/notifications.js";
import { randomUUID } from "node:crypto";
import { decideAlert, detectObjects, type Detection } from "../lib/detector.js";
import { captureJpeg, jpegToDetectorInput } from "../lib/snapshot.js";
import { buildSnapshotObjectKey, uploadObject } from "../lib/storage.js";

const CONCURRENCY = 4;

export interface MotionCheckResult {
  checked: number;
  detected: number;
  failed: number;
}

type Sampler = (rtspUrl: string, seconds: number) => Promise<MotionSampleResult>;

export interface FrameAnalysis {
  /** JPEG snapshot, or null if no frame could be grabbed. */
  jpeg: Buffer | null;
  /** Detections, or null when the detector/frame was unavailable. */
  detections: Detection[] | null;
}
export type Analyzer = (streamUrl: string) => Promise<FrameAnalysis>;

/** Default analyzer: grab one frame, run person/vehicle detection on it.
 * Every step is best-effort — a failure degrades to a plain motion alert. */
export const analyzeFrame: Analyzer = async (streamUrl) => {
  let jpeg: Buffer;
  try {
    jpeg = await captureJpeg(streamUrl);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "snapshot capture failed");
    return { jpeg: null, detections: null };
  }
  try {
    const rgb = await jpegToDetectorInput(jpeg);
    return { jpeg, detections: await detectObjects(new Uint8Array(rgb)) };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "object detection failed");
    return { jpeg, detections: null };
  }
};

/** Records a detection: always a MotionEvent row (with labels + snapshot
 * when available), plus an alert (in-app, webhooks, push) at most once per
 * cooldown window per camera and alert type — if the camera's alert classes
 * match (see decideAlert). */
export async function recordMotion(
  camera: { id: string; tenantId: string; name: string; motionAlertClasses?: string[] },
  score: number,
  threshold: number,
  analysis: FrameAnalysis = { jpeg: null, detections: null },
) {
  const env = loadEnv();
  const eventId = randomUUID();
  let snapshotKey: string | null = null;
  if (analysis.jpeg) {
    const key = buildSnapshotObjectKey(camera.tenantId, camera.id, eventId);
    try {
      await uploadObject(key, analysis.jpeg, "image/jpeg");
      snapshotKey = key;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, cameraId: camera.id }, "snapshot upload failed");
    }
  }
  const event = await prisma.motionEvent.create({
    data: {
      id: eventId,
      tenantId: camera.tenantId,
      cameraId: camera.id,
      score,
      threshold,
      labels: analysis.detections === null ? undefined : (analysis.detections as unknown as object[]),
      snapshotKey,
    },
  });
  const decision = decideAlert(camera.motionAlertClasses ?? ["any"], analysis.detections);
  let alerted = false;
  if (decision.alert) {
    alerted = await notifyOnce({
      tenantId: camera.tenantId,
      type: decision.type,
      targetId: camera.id,
      message: `${decision.summary} on "${camera.name}".`,
      cooldownMinutes: env.MOTION_ALERT_COOLDOWN_MINUTES,
      eventId: event.id,
    });
  }
  return { event, alerted, decision };
}

/** One pass over every motion-enabled camera. Each camera is read through
 * its MediaMTX path (shared with live view/recording), so the camera itself
 * gets no extra connection. One camera failing never affects the others. */
export async function checkMotionForAllCameras(
  sampler: Sampler = sampleMotion,
  analyzer: Analyzer = analyzeFrame,
  /** Restrict to these cameras (tests); default = every enabled camera. */
  cameraIds?: string[],
): Promise<MotionCheckResult> {
  const env = loadEnv();
  const cameras = await prisma.camera.findMany({
    where: { motionEnabled: true, tenant: { suspendedAt: null }, ...(cameraIds ? { id: { in: cameraIds } } : {}) },
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
          const analysis = await analyzer(relayUrl);
          await recordMotion(camera, sample.maxScore, threshold, analysis);
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
