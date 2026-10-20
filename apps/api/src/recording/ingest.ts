import { randomUUID } from "node:crypto";
import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { listSegments, fetchSegment, deleteSegment, type RecordingSegmentRef } from "../connectors/mediamtx-client.js";
import { probeFileDurationSeconds } from "../connectors/file-probe.js";
import { buildRecordingObjectKey, uploadRecordingSegment } from "../lib/storage.js";

interface IngestContext {
  tenantId: string;
  cameraId: string;
  jobId: string;
  /** The job's configured target segment length — only used to size the
   * generous upper-bound duration passed to MediaMTX's playback fetch for
   * the one segment where the real duration isn't yet known (see below).
   * Never used as the duration actually stored in the DB. */
  segmentSeconds: number;
}

/**
 * A camera's own retention policy wins; otherwise the tenant's default
 * policy; otherwise `null` — meaning "no policy, keep indefinitely," not
 * "delete immediately." Retention enforcement (recording/retention.ts) only
 * ever acts on segments with a real `retentionExpiresAt`, so a camera with
 * no resolvable policy is never touched — matches the product rule against
 * deleting anything when the policy is ambiguous/unset.
 */
async function resolveRetentionDays(tenantId: string, cameraId: string): Promise<number | null> {
  const camera = await prisma.camera.findUnique({
    where: { id: cameraId },
    select: { retentionPolicy: { select: { retentionDays: true } } },
  });
  if (camera?.retentionPolicy) return camera.retentionPolicy.retentionDays;

  const tenantDefault = await prisma.retentionPolicy.findFirst({
    where: { tenantId, isDefault: true },
    select: { retentionDays: true },
  });
  return tenantDefault?.retentionDays ?? null;
}

interface SegmentDuration {
  /** Passed to MediaMTX's playback /get as the max duration to return.
   * Can safely be a generous over-estimate — MediaMTX clips to whatever
   * real data exists rather than padding or erroring (verified manually). */
  requestSeconds: number;
  /** The duration to persist in the DB. `null` means "not known yet —
   * determine it from the downloaded file itself," which is ground truth
   * and should be preferred over any estimate whenever the exact duration
   * isn't already known from timestamp arithmetic. */
  exactSeconds: number | null;
}

/**
 * Downloads one segment from MediaMTX, uploads it to S3, and records it.
 * Only deletes the segment from MediaMTX's own disk after both the upload
 * and the DB write succeed — if either fails, the segment is left in place
 * so the next poll retries it, instead of silently losing footage.
 */
async function ingestOneSegment(
  ctx: IngestContext,
  start: string,
  duration: SegmentDuration,
  retentionDays: number | null,
): Promise<void> {
  const buffer = await fetchSegment(ctx.cameraId, start, duration.requestSeconds);

  // Never report a recording as successful if no real video was received —
  // an empty/near-empty response means something's wrong upstream (source
  // dropped, etc.), not a valid segment to keep.
  if (buffer.length < 1024) {
    throw new Error(`segment ${start} returned only ${buffer.length} bytes — refusing to treat as valid`);
  }

  // Ground truth from the real file when the duration isn't already known
  // precisely — guessing here previously stored a wildly wrong durationSec
  // (e.g. claiming 20s for a recording stopped after 3s of real footage).
  const exactSeconds = duration.exactSeconds ?? (await probeFileDurationSeconds(buffer));

  const startedAt = new Date(start);
  const recordingId = randomUUID();
  const objectKey = buildRecordingObjectKey(ctx.tenantId, ctx.cameraId, startedAt, recordingId);

  await uploadRecordingSegment(objectKey, buffer);

  await prisma.recordingSegment.create({
    data: {
      tenantId: ctx.tenantId,
      cameraId: ctx.cameraId,
      jobId: ctx.jobId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + exactSeconds * 1000),
      durationSec: Math.round(exactSeconds),
      objectKey,
      fileSizeBytes: BigInt(buffer.length),
      status: "COMPLETE",
      retentionExpiresAt:
        retentionDays != null ? new Date(startedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000) : null,
    },
  });

  await deleteSegment(ctx.cameraId, start);
}

/**
 * Ingests whatever segments MediaMTX has finished writing for this camera.
 *
 * `includeLast` must be false during normal/periodic polling — the most
 * recent segment in the list might still be actively being written, and
 * ingesting it mid-write would both produce a truncated/wrong-duration
 * recording and race with MediaMTX's own file handle. It's only safe to
 * pass true after recording has been explicitly stopped (record patched to
 * false), at which point every listed segment, including the last, is
 * finalized — see the recording/stop route.
 */
export async function drainPendingSegments(
  ctx: IngestContext,
  opts: { includeLast: boolean },
): Promise<{ ingested: number; failed: number }> {
  const segments: RecordingSegmentRef[] = await listSegments(ctx.cameraId);
  if (segments.length === 0) return { ingested: 0, failed: 0 };

  // Resolved once per poll, not per segment — a camera's policy doesn't
  // change mid-poll, and this avoids N redundant lookups for N segments.
  const retentionDays = await resolveRetentionDays(ctx.tenantId, ctx.cameraId);

  const upperBound = opts.includeLast ? segments.length : segments.length - 1;
  let ingested = 0;
  let failed = 0;

  for (let i = 0; i < upperBound; i++) {
    const segment = segments[i]!;

    const alreadyIngested = await prisma.recordingSegment.findFirst({
      where: { cameraId: ctx.cameraId, startedAt: new Date(segment.start) },
      select: { id: true },
    });
    if (alreadyIngested) continue;

    const next = segments[i + 1];
    const duration: SegmentDuration = next
      ? {
          // The gap to a real next segment IS the exact duration — already
          // verified against real recordings to match ffprobe within noise.
          exactSeconds: (new Date(next.start).getTime() - new Date(segment.start).getTime()) / 1000,
          requestSeconds: (new Date(next.start).getTime() - new Date(segment.start).getTime()) / 1000,
        }
      : {
          // True final segment of a stopped recording — duration unknown
          // until we've downloaded it and ffprobed the real file.
          exactSeconds: null,
          requestSeconds: ctx.segmentSeconds * 2,
        };

    try {
      await ingestOneSegment(ctx, segment.start, duration, retentionDays);
      ingested++;
    } catch (err) {
      failed++;
      logger.error({ err, cameraId: ctx.cameraId, segmentStart: segment.start }, "failed to ingest recording segment");
    }
  }

  return { ingested, failed };
}
