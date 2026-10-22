import { spawn } from "node:child_process";
import { loadEnv } from "../env.js";

/**
 * Motion detection by frame differencing. ffmpeg's `scene` score (0..1) is
 * the normalised difference between consecutive frames; a static scene
 * stays near 0, movement pushes it up. Frames are downscaled and sampled at
 * a low frame rate so one check costs very little CPU.
 */

export const MIN_SENSITIVITY = 1;
export const MAX_SENSITIVITY = 100;

/** Maps the user-facing 1..100 sensitivity to a scene-score threshold:
 * 100 → 0.002 (tiny changes trigger), 50 → ~0.02, 1 → 0.20. Logarithmic,
 * because useful thresholds span two orders of magnitude. */
export function sensitivityToThreshold(sensitivity: number): number {
  const s = Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, Math.round(sensitivity)));
  const hi = Math.log(0.2);
  const lo = Math.log(0.002);
  const t = (s - MIN_SENSITIVITY) / (MAX_SENSITIVITY - MIN_SENSITIVITY);
  return Number(Math.exp(hi + (lo - hi) * t).toFixed(4));
}

/** Pulls every `lavfi.scene_score=` value out of ffmpeg metadata output. */
export function parseSceneScores(output: string): number[] {
  const scores: number[] = [];
  for (const m of output.matchAll(/lavfi\.scene_score=([0-9]*\.?[0-9]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) scores.push(v);
  }
  return scores;
}

export interface MotionSampleResult {
  maxScore: number;
  frames: number;
}

export class MotionSampleError extends Error {}

/** ffmpeg argument list (no shell is involved, so the URL can't inject). */
export function buildFfmpegArgs(rtspUrl: string, seconds: number): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-t", String(seconds),
    "-i", rtspUrl,
    "-an",
    "-vf", "fps=4,scale=320:-2,select='gte(scene\\,0)',metadata=print:file=-",
    "-f", "null", "-",
  ];
}

/** Samples `seconds` of video from `rtspUrl` and returns the peak scene score. */
export function sampleMotion(rtspUrl: string, seconds: number): Promise<MotionSampleResult> {
  const env = loadEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFMPEG_PATH, buildFfmpegArgs(rtspUrl, seconds), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), (seconds + 15) * 1000);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new MotionSampleError(`ffmpeg could not start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const scores = parseSceneScores(stdout);
      if (scores.length === 0) {
        // Never include the URL (it may carry a credential) in the error.
        const reason = stderr.split("\n").find((l) => l.trim()) ?? `exit code ${code}`;
        return reject(new MotionSampleError(`no frames received (${reason.replaceAll(rtspUrl, "<stream>").slice(0, 200)})`));
      }
      resolve({ maxScore: Math.max(...scores), frames: scores.length });
    });
  });
}
