import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, mediamtxPathName } from "../connectors/mediamtx-client.js";
import { sampleMotion, sensitivityToThreshold, type MotionSampleOptions, type MotionSampleResult } from "../lib/motion.js";
import { notifyOnce } from "../lib/notifications.js";
import { randomUUID } from "node:crypto";
import {
  applyClassThresholds,
  decideAlert,
  detectObjects,
  minThreshold,
  type ClassThresholds,
  type Detection,
} from "../lib/detector.js";
import { buildMaskPgm, filterDetectionsByZones, normalizeMaskedScore, parseZones, type Zone } from "../lib/zones.js";
import { isAlertActive, parseSchedule } from "../lib/schedule.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureJpeg, jpegToDetectorInput } from "../lib/snapshot.js";
import { buildSnapshotObjectKey, uploadObject } from "../lib/storage.js";

const CONCURRENCY = 4;

export interface MotionCheckResult {
  checked: number;
  detected: number;
  failed: number;
}

type Sampler = (rtspUrl: string, seconds: number, opts?: MotionSampleOptions) => Promise<MotionSampleResult>;

export interface FrameAnalysis {
  /** JPEG snapshot, or null if no frame could be grabbed. */
  jpeg: Buffer | null;
  /** Detections, or null when the detector/frame was unavailable. */
  detections: Detection[] | null;
}
export type Analyzer = (streamUrl: string, opts?: { minScore?: number }) => Promise<FrameAnalysis>;

/** Default analyzer: grab one frame, run person/vehicle detection on it.
 * Every step is best-effort — a failure degrades to a plain motion alert. */
export const analyzeFrame: Analyzer = async (streamUrl, opts = {}) => {
  let jpeg: Buffer;
  try {
    jpeg = await captureJpeg(streamUrl);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "snapshot capture failed");
    return { jpeg: null, detections: null };
  }
  try {
    const rgb = await jpegToDetectorInput(jpeg);
    return { jpeg, detections: await detectObjects(new Uint8Array(rgb), opts.minScore) };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "object detection failed");
    return { jpeg, detections: null };
  }
};

/** Records a detection: always a MotionEvent row (with labels + snapshot
 * when available), plus an alert (in-app, webhooks, push) at most once per
 * cooldown window per camera and alert type — if the camera's alert classes
 * match (see decideAlert). */
export interface DetectionConfig {
  zones: Zone[];
  thresholds: ClassThresholds | null;
  /** False outside the camera's alert schedule: the event is still recorded
   * (history, snapshot), but no alert/push is sent. */
  alertsActive: boolean;
}

/** Applies per-class thresholds, then zones. Null (detector unavailable)
 * passes through so the motion fallback still works. */
export function filterDetections(detections: Detection[] | null, cfg: Pick<DetectionConfig, "zones" | "thresholds">): Detection[] | null {
  if (detections === null) return null;
  const fallback = loadEnv().DETECTION_MIN_SCORE;
  return filterDetectionsByZones(applyClassThresholds(detections, cfg.thresholds, fallback), cfg.zones);
}

export async function recordMotion(
  camera: { id: string; tenantId: string; name: string; motionAlertClasses?: string[] },
  score: number,
  threshold: number,
  analysis: FrameAnalysis = { jpeg: null, detections: null },
  cfg: DetectionConfig = { zones: [], thresholds: null, alertsActive: true },
) {
  const env = loadEnv();
  analysis = { ...analysis, detections: filterDetections(analysis.detections, cfg) };
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
  const decision = cfg.alertsActive
    ? decideAlert(camera.motionAlertClasses ?? ["any"], analysis.detections)
    : ({ alert: false } as const);
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
    include: { credential: true, tenant: { select: { timezone: true } } },
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
        const zones = parseZones(camera.detectionZones);
        const thresholds = (camera.detectionThresholds ?? null) as ClassThresholds | null;
        const mask = zones.length ? await zoneMask(camera.id, zones) : null;
        const sample = await sampler(relayUrl, env.MOTION_SAMPLE_SECONDS, mask ? { maskPath: mask.path } : {});
        const score = mask ? normalizeMaskedScore(sample.maxScore, mask.coverage) : sample.maxScore;
        const threshold = sensitivityToThreshold(camera.motionSensitivity);
        result.checked++;
        if (score >= threshold) {
          const analysis = await analyzer(relayUrl, { minScore: minThreshold(thresholds, env.DETECTION_MIN_SCORE) });
          const alertsActive = isAlertActive(parseSchedule(camera.alertSchedule), new Date(), camera.tenant?.timezone ?? "UTC");
          await recordMotion(camera, Number(score.toFixed(4)), threshold, analysis, { zones, thresholds, alertsActive });
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

/** Writes (once per zone layout) the PGM mask ffmpeg multiplies frames by. */
async function zoneMask(cameraId: string, zones: Zone[]): Promise<{ path: string; coverage: number }> {
  const { pgm, coverage } = buildMaskPgm(zones);
  const hash = createHash("sha256").update(pgm).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "cctv-zone-masks");
  const path = join(dir, `${cameraId}-${hash}.pgm`);
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, pgm);
  }
  return { path, coverage };
}
