import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * Returns the real duration (seconds) of a downloaded MP4 buffer by probing
 * it with ffprobe. Used only when a segment's duration can't be computed
 * from the gap to its next segment's start time (the final segment of a
 * drained recording, see recording/ingest.ts) — ffprobing the actual bytes
 * is ground truth; guessing from the configured segment length is not,
 * since MediaMTX cuts a stopped recording's last segment short.
 */
export async function probeFileDurationSeconds(buffer: Buffer): Promise<number> {
  const tmpPath = join(tmpdir(), `segment-probe-${randomUUID()}.mp4`);
  await writeFile(tmpPath, buffer);

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn(
        FFPROBE_PATH,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tmpPath],
        { windowsHide: true },
      );

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}`));
          return;
        }
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration)) {
          reject(new Error(`ffprobe returned an unparseable duration: ${stdout.trim()}`));
          return;
        }
        resolve(duration);
      });
    });
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}
