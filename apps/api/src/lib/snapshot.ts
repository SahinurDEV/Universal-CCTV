import { spawn } from "node:child_process";
import { loadEnv } from "../env.js";
import { detectorInputSize } from "./detector.js";

function runFfmpeg(args: string[], input: Buffer | null, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(loadEnv().FFMPEG_PATH, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 20_000_000) chunks.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code !== 0 || out.length === 0) return reject(new Error(`ffmpeg failed (exit ${code})`));
      resolve(out);
    });
    if (input && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
}

/** Grabs one JPEG frame (max 640 px wide) from a stream. argv only, no shell;
 * errors never include the URL (it may embed a credential). */
export function captureJpeg(streamUrl: string): Promise<Buffer> {
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(streamUrl.startsWith("rtsp") ? ["-rtsp_transport", "tcp"] : []),
    // Decode keyframes only: joining a live stream mid-GOP otherwise yields
    // a half-grey/smeared first frame, which hurts detection.
    "-skip_frame", "nokey",
    "-i", streamUrl,
    "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "5",
    "-f", "mjpeg", "-",
  ];
  return runFfmpeg(args, null, 20_000);
}

/** Decodes a JPEG into the detector's square RGB24 input. */
export function jpegToDetectorInput(jpeg: Buffer, size = detectorInputSize()): Promise<Buffer> {
  const n = size;
  return runFfmpeg(
    ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "-", "-vf", `scale=${n}:${n}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    jpeg,
    10_000,
  );
}
