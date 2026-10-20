import { spawn } from "node:child_process";
import type { CameraCapabilities } from "@cctv/shared";
import { EMPTY_CAPABILITIES } from "@cctv/shared";

const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const PROBE_TIMEOUT_MS = 8000;

export interface RtspProbeStream {
  codecType: "video" | "audio" | string;
  codecName: string;
  width?: number;
  height?: number;
  frameRate?: string;
}

export type RtspProbeResult =
  | { ok: true; streams: RtspProbeStream[] }
  | { ok: false; reason: "timeout" | "connection_failed"; message: string };

/**
 * Probes an RTSP URL with ffprobe and reports what streams are actually
 * present. Never logs `rtspUrl` (it embeds the camera credential) — on
 * failure, ffprobe's stderr is scrubbed of the URL before being surfaced,
 * since ffprobe echoes back the input URL (including credentials) in its
 * own error output.
 */
export function probeRtspStream(rtspUrl: string): Promise<RtspProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      String(PROBE_TIMEOUT_MS * 1000), // microseconds
      "-print_format",
      "json",
      "-show_streams",
      rtspUrl,
    ];

    const proc = spawn(FFPROBE_PATH, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      resolve({ ok: false, reason: "timeout", message: "Connection timed out." });
    }, PROBE_TIMEOUT_MS + 2000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "connection_failed", message: `ffprobe could not be started: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          ok: false,
          reason: "connection_failed",
          message: scrubUrl(stderr, rtspUrl).trim() || `ffprobe exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> };
        const streams: RtspProbeStream[] = (parsed.streams ?? []).map((s) => ({
          codecType: String(s.codec_type),
          codecName: String(s.codec_name),
          width: typeof s.width === "number" ? s.width : undefined,
          height: typeof s.height === "number" ? s.height : undefined,
          frameRate: typeof s.r_frame_rate === "string" ? s.r_frame_rate : undefined,
        }));
        resolve({ ok: true, streams });
      } catch {
        resolve({ ok: false, reason: "connection_failed", message: "Could not parse ffprobe output." });
      }
    });
  });
}

function scrubUrl(text: string, url: string): string {
  return text.split(url).join("[rtsp url redacted]");
}

/**
 * Maps a successful probe result to the capability model. RTSP-only probing
 * can only honestly confirm: a video stream exists (liveView, and therefore
 * our own cloudRecording/playback become possible), and whether an audio
 * stream is present. PTZ/zoom/motionEvents/imageSettings/firmwareUpdate are
 * ONVIF-confirmed capabilities and stay false here — this function never
 * sets them, by design (see docs/architecture.md §3).
 */
export function capabilitiesFromRtspProbe(streams: RtspProbeStream[]): CameraCapabilities {
  const hasVideo = streams.some((s) => s.codecType === "video");
  const hasAudio = streams.some((s) => s.codecType === "audio");

  return {
    ...EMPTY_CAPABILITIES,
    liveView: hasVideo,
    cloudRecording: hasVideo,
    playback: hasVideo,
    audio: hasAudio,
  };
}
