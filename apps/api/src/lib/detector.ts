import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

/** COCO labels we care about, keyed by name. */
const WANTED = new Set(["person", "bicycle", "car", "motorcycle", "bus", "truck"]);
/** SSD MobileNet v1 (TF numbering, 1-based with gaps). */
const SSD_LABELS: Record<number, string> = { 1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 6: "bus", 8: "truck" };
/** RT-DETR / contiguous 80-class COCO numbering (0-based). */
const COCO80_LABELS: Record<number, string> = { 0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck" };
const VEHICLE_LABELS = new Set(["bicycle", "car", "motorcycle", "bus", "truck"]);

export const ALERT_CLASSES = ["any", "person", "vehicle"] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];
export const DETECTION_CATEGORIES = ["person", "vehicle"] as const;
export type DetectionCategory = (typeof DETECTION_CATEGORIES)[number];

export interface Detection {
  label: string;
  category: DetectionCategory;
  score: number;
  /** Normalised [x, y, w, h] in 0..1 of the frame (top-left origin). */
  box?: [number, number, number, number];
}

export type DetectorModelId = "ssd-mobilenet-v1" | "rtdetr-r18";

export interface DetectorModelInfo {
  id: DetectorModelId;
  name: string;
  license: string;
  source: string;
  inputSize: number;
  defaultPath: string;
  url: string;
  sha256: string;
}

/** Built-in detectors. Licenses verified: both permissive (Apache-2.0); no
 * AGPL (e.g. Ultralytics YOLO) models are used. */
export const MODELS: Record<DetectorModelId, DetectorModelInfo> = {
  "ssd-mobilenet-v1": {
    id: "ssd-mobilenet-v1",
    name: "SSD MobileNet v1 (COCO)",
    license: "Apache-2.0 (ONNX Model Zoo)",
    source: "https://github.com/onnx/models/tree/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1",
    inputSize: 300,
    defaultPath: "models/ssd_mobilenet_v1_12.onnx",
    url: "https://github.com/onnx/models/raw/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1/model/ssd_mobilenet_v1_12.onnx",
    sha256: "b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058",
  },
  "rtdetr-r18": {
    id: "rtdetr-r18",
    name: "RT-DETR R18vd (COCO)",
    license: "Apache-2.0 (PekingU/rtdetr_r18vd weights; ONNX export by onnx-community)",
    source: "https://huggingface.co/PekingU/rtdetr_r18vd",
    inputSize: 640,
    defaultPath: "models/rtdetr_r18vd.onnx",
    url: "https://huggingface.co/onnx-community/rtdetr_r18vd/resolve/main/onnx/model.onnx",
    sha256: "11843b02455cc24009aed24d4c40db721b1093be5ccd6bbe7b9c441abb1d0558",
  },
};

export function activeModel(): DetectorModelInfo {
  return MODELS[loadEnv().DETECTION_MODEL];
}
/** Square input size of the active detector (frames are resized to this). */
export function detectorInputSize(): number {
  return activeModel().inputSize;
}

function categoryOf(label: string): DetectionCategory {
  return label === "person" ? "person" : "vehicle";
}
const round = (v: number) => Number(Math.min(1, Math.max(0, v)).toFixed(4));

/** SSD outputs → person/vehicle detections above `minScore`, best first.
 * `boxes` (optional) are TF-style [ymin, xmin, ymax, xmax] per detection. */
export function parseDetections(
  classes: ArrayLike<number>,
  scores: ArrayLike<number>,
  count: number,
  minScore: number,
  boxes?: ArrayLike<number>,
): Detection[] {
  const out: Detection[] = [];
  const n = Math.min(count, classes.length, scores.length);
  for (let i = 0; i < n; i++) {
    const score = Number(scores[i]);
    const label = SSD_LABELS[Math.round(Number(classes[i]))];
    if (!label || !(score >= minScore)) continue;
    const d: Detection = { label, category: categoryOf(label), score: Number(score.toFixed(3)) };
    if (boxes && boxes.length >= (i + 1) * 4) {
      const [y0, x0, y1, x1] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!].map(Number);
      d.box = [round(x0!), round(y0!), round(x1! - x0!), round(y1! - y0!)];
    }
    out.push(d);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** RT-DETR outputs (logits [Q,C], pred_boxes [Q,4] as cx,cy,w,h) → detections. */
export function parseRtDetr(logits: ArrayLike<number>, boxes: ArrayLike<number>, queries: number, numClasses: number, minScore: number): Detection[] {
  const out: Detection[] = [];
  for (let q = 0; q < queries; q++) {
    let best = -Infinity;
    let cls = -1;
    for (let c = 0; c < numClasses; c++) {
      const v = Number(logits[q * numClasses + c]);
      if (v > best) {
        best = v;
        cls = c;
      }
    }
    const label = COCO80_LABELS[cls];
    const score = 1 / (1 + Math.exp(-best));
    if (!label || !(score >= minScore)) continue;
    const [cx, cy, w, h] = [boxes[q * 4], boxes[q * 4 + 1], boxes[q * 4 + 2], boxes[q * 4 + 3]].map(Number) as [number, number, number, number];
    out.push({ label, category: categoryOf(label), score: Number(score.toFixed(3)), box: [round(cx - w / 2), round(cy - h / 2), round(w), round(h)] });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Per-class confidence thresholds (0..1). Missing classes use `fallback`. */
export type ClassThresholds = Partial<Record<DetectionCategory, number>>;

export function applyClassThresholds(detections: Detection[], thresholds: ClassThresholds | null | undefined, fallback: number): Detection[] {
  return detections.filter((d) => d.score >= (thresholds?.[d.category] ?? fallback));
}

/** Lowest threshold in use — the detector must report at least down to it. */
export function minThreshold(thresholds: ClassThresholds | null | undefined, fallback: number): number {
  const vals = DETECTION_CATEGORIES.map((c) => thresholds?.[c] ?? fallback);
  return Math.min(...vals);
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
let sessionModel: DetectorModelId | null = null;
let ort: OrtModule | null = null;
let loading: Promise<Session | null> | null = null;
let lastFailureAt = 0;
const RETRY_AFTER_MS = 10 * 60_000;

function modelFiles(model: DetectorModelInfo = activeModel()) {
  const env = loadEnv();
  return {
    path: resolve(process.cwd(), env.DETECTION_MODEL_PATH ?? model.defaultPath),
    url: env.DETECTION_MODEL_URL ?? model.url,
    sha256: env.DETECTION_MODEL_SHA256 ?? model.sha256,
  };
}

export function modelPath(): string {
  return modelFiles().path;
}

/** Downloads the active model and verifies its SHA-256. Writes to a temp
 * file first so a partial download is never loaded. */
export async function downloadModel(): Promise<string> {
  const { path: dest, url, sha256 } = modelFiles();
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  if (sha256) {
    const hash = createHash("sha256").update(await readFile(tmp)).digest("hex");
    if (hash !== sha256.toLowerCase()) {
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
  if (session && sessionModel === env.DETECTION_MODEL) return session;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return null;
  loading ??= (async () => {
    try {
      const { path } = modelFiles();
      if (!existsSync(path)) {
        if (!env.DETECTION_AUTO_DOWNLOAD) throw new Error(`model not found at ${path}`);
        logger.info({ path, model: env.DETECTION_MODEL }, "downloading object-detection model (first run)");
        await downloadModel();
      }
      ort ??= await import("onnxruntime-node");
      session = await ort.InferenceSession.create(path);
      sessionModel = env.DETECTION_MODEL;
      logger.info({ model: env.DETECTION_MODEL }, "object-detection model loaded");
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

/** Runs the active detector on a detectorInputSize()² RGB24 frame. Returns
 * person/vehicle detections ≥ `minScore` (default DETECTION_MIN_SCORE). */
export async function detectObjects(rgb: Uint8Array, minScore = loadEnv().DETECTION_MIN_SCORE): Promise<Detection[] | null> {
  const s = await getDetector();
  if (!s || !ort) return null;
  const model = activeModel();
  const size = model.inputSize;
  if (rgb.length !== size * size * 3) throw new Error("unexpected frame size");
  if (model.id === "rtdetr-r18") {
    // NCHW float32, rescaled to 0..1, no mean/std normalisation (per the
    // model's preprocessor_config.json).
    const n = size * size;
    const f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      f[i] = rgb[i * 3]! / 255;
      f[n + i] = rgb[i * 3 + 1]! / 255;
      f[2 * n + i] = rgb[i * 3 + 2]! / 255;
    }
    const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor("float32", f, [1, 3, size, size]) });
    const logits = out.logits!;
    const [, q, c] = logits.dims as number[];
    return parseRtDetr(logits.data as Float32Array, out.pred_boxes!.data as Float32Array, q!, c!, minScore);
  }
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor("uint8", rgb, [1, size, size, 3]) });
  const classes = out.detection_classes?.data as Float32Array;
  const scores = out.detection_scores?.data as Float32Array;
  const boxes = out.detection_boxes?.data as Float32Array | undefined;
  const num = Number((out.num_detections?.data as Float32Array)?.[0] ?? 0);
  return parseDetections(classes, scores, num, minScore, boxes);
}

/** Test hook. */
export function resetDetectorForTests() {
  session = null;
  sessionModel = null;
  loading = null;
  lastFailureAt = 0;
}

export { VEHICLE_LABELS, WANTED };
