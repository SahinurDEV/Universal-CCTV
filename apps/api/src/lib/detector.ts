import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

/** COCO class ids (SSD MobileNet v1 numbering) we care about. */
const COCO_LABELS: Record<number, string> = {
  1: "person",
  2: "bicycle",
  3: "car",
  4: "motorcycle",
  6: "bus",
  8: "truck",
};
const VEHICLE_LABELS = new Set(["bicycle", "car", "motorcycle", "bus", "truck"]);

export const ALERT_CLASSES = ["any", "person", "vehicle"] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];
export const DETECTOR_INPUT_SIZE = 300;

export interface Detection {
  label: string;
  category: "person" | "vehicle";
  score: number;
}

/** Turns raw SSD outputs into person/vehicle detections above `minScore`
 * (other COCO classes are ignored), highest score first. */
export function parseDetections(
  classes: ArrayLike<number>,
  scores: ArrayLike<number>,
  count: number,
  minScore: number,
): Detection[] {
  const out: Detection[] = [];
  const n = Math.min(count, classes.length, scores.length);
  for (let i = 0; i < n; i++) {
    const score = Number(scores[i]);
    const label = COCO_LABELS[Math.round(Number(classes[i]))];
    if (!label || !(score >= minScore)) continue;
    out.push({ label, category: label === "person" ? "person" : "vehicle", score: Number(score.toFixed(3)) });
  }
  return out.sort((a, b) => b.score - a.score);
}

export type AlertDecision =
  | { alert: false }
  | { alert: true; type: "PERSON_DETECTED" | "VEHICLE_DETECTED" | "MOTION_DETECTED"; summary: string };

/** Decides whether (and how) to alert for one motion event.
 *  - detector unavailable → plain motion alert (fallback), always.
 *  - "any" selected → alert; typed as person/vehicle when one was seen.
 *  - otherwise alert only when a selected category was detected. */
export function decideAlert(wanted: string[], detections: Detection[] | null): AlertDecision {
  if (detections === null) return { alert: true, type: "MOTION_DETECTED", summary: "Motion detected" };
  const hasPerson = detections.some((d) => d.category === "person");
  const hasVehicle = detections.some((d) => d.category === "vehicle");
  const wantAny = wanted.length === 0 || wanted.includes("any");
  const personHit = hasPerson && (wantAny || wanted.includes("person"));
  const vehicleHit = hasVehicle && (wantAny || wanted.includes("vehicle"));
  if (personHit) return { alert: true, type: "PERSON_DETECTED", summary: describe(detections, "Person detected") };
  if (vehicleHit) return { alert: true, type: "VEHICLE_DETECTED", summary: describe(detections, "Vehicle detected") };
  if (wantAny) return { alert: true, type: "MOTION_DETECTED", summary: "Motion detected" };
  return { alert: false };
}

function describe(detections: Detection[], head: string): string {
  const counts = new Map<string, number>();
  for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  const parts = [...counts].map(([l, c]) => (c > 1 ? `${c}× ${l}` : l));
  return `${head} (${parts.join(", ")})`;
}

// ---------------------------------------------------------------- model

type OrtModule = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

let session: Session | null = null;
let ort: OrtModule | null = null;
let loading: Promise<Session | null> | null = null;
let lastFailureAt = 0;
const RETRY_AFTER_MS = 10 * 60_000;

export function modelPath(): string {
  return resolve(process.cwd(), loadEnv().DETECTION_MODEL_PATH);
}

/** Downloads the model to DETECTION_MODEL_PATH and verifies its SHA-256.
 * Writes to a temp file first so a partial download is never loaded. */
export async function downloadModel(): Promise<string> {
  const env = loadEnv();
  const dest = modelPath();
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const res = await fetch(env.DETECTION_MODEL_URL, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  if (env.DETECTION_MODEL_SHA256) {
    const hash = createHash("sha256").update(await readFile(tmp)).digest("hex");
    if (hash !== env.DETECTION_MODEL_SHA256.toLowerCase()) {
      await rm(tmp, { force: true });
      throw new Error("model checksum mismatch — refusing to use the downloaded file");
    }
  }
  await rename(tmp, dest);
  return dest;
}

/** Returns a loaded model session, or null when detection is disabled or
 * the model can't be obtained (callers then fall back to plain motion). */
export async function getDetector(): Promise<Session | null> {
  const env = loadEnv();
  if (!env.DETECTION_ENABLED) return null;
  if (session) return session;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return null;
  loading ??= (async () => {
    try {
      const path = modelPath();
      if (!existsSync(path)) {
        if (!env.DETECTION_AUTO_DOWNLOAD) throw new Error(`model not found at ${path}`);
        logger.info({ path }, "downloading object-detection model (first run)");
        await downloadModel();
      }
      ort ??= await import("onnxruntime-node");
      session = await ort.InferenceSession.create(path);
      logger.info("object-detection model loaded");
      return session;
    } catch (err) {
      lastFailureAt = Date.now();
      logger.warn({ err: err instanceof Error ? err.message : err }, "object detection unavailable — using plain motion alerts");
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Runs the detector on a DETECTOR_INPUT_SIZE² RGB24 frame. */
export async function detectObjects(rgb: Uint8Array): Promise<Detection[] | null> {
  const s = await getDetector();
  if (!s || !ort) return null;
  const size = DETECTOR_INPUT_SIZE;
  if (rgb.length !== size * size * 3) throw new Error("unexpected frame size");
  const input = new ort.Tensor("uint8", rgb, [1, size, size, 3]);
  const out = await s.run({ [s.inputNames[0]!]: input });
  const classes = out.detection_classes?.data as Float32Array;
  const scores = out.detection_scores?.data as Float32Array;
  const num = Number((out.num_detections?.data as Float32Array)?.[0] ?? 0);
  return parseDetections(classes, scores, num, loadEnv().DETECTION_MIN_SCORE);
}

/** Test hook. */
export function resetDetectorForTests() {
  session = null;
  loading = null;
  lastFailureAt = 0;
}

export { VEHICLE_LABELS };
