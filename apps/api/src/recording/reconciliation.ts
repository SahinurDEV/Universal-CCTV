import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { listAllRecordingObjects, deleteStorageObject } from "../lib/storage.js";

/**
 * How old an object must be before it's even considered a reconciliation
 * candidate. Two real sources of orphaned objects exist:
 *   1. `recording/ingest.ts` uploads to S3 BEFORE writing the DB row — a
 *      crash in that narrow window leaves an object with no row. On retry,
 *      a *new* random object key is generated for the same segment, so the
 *      first upload is orphaned forever, not just delayed.
 *   2. Deleting a camera (`DELETE /cameras/:id`) cascades away every
 *      `RecordingSegment` row for it in the database (Prisma
 *      `onDelete: Cascade` on `RecordingSegment.camera`) but never touches
 *      the camera's S3 objects — confirmed by reading the schema, not
 *      assumed. This is the larger, more common source in practice.
 * This window exists purely so a segment mid-ingest (upload done, DB write
 * not yet committed — normally milliseconds) is never mistaken for an
 * orphan and deleted out from under a request that's about to succeed.
 */
export const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

export interface ReconciliationResult {
  scanned: number;
  orphaned: number;
  deleted: number;
  failed: number;
}

/**
 * Finds every object in the recordings bucket with no matching
 * `RecordingSegment.objectKey` row — regardless of that row's status, since
 * even a `DELETED` row means something already claims ownership of that
 * key's lifecycle — and deletes it. This is the only mechanism that cleans
 * up after a deleted camera's orphaned recordings; nothing else in the
 * system does, per docs/retention-and-storage.md's previously-documented
 * gap.
 */
export async function reconcileOrphanedObjects(opts?: { minAgeMs?: number }): Promise<ReconciliationResult> {
  const minAgeMs = opts?.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const cutoff = Date.now() - minAgeMs;

  const objects = await listAllRecordingObjects();
  const candidates = objects.filter((o) => o.lastModified.getTime() < cutoff);

  if (candidates.length === 0) {
    return { scanned: objects.length, orphaned: 0, deleted: 0, failed: 0 };
  }

  const knownKeys = new Set<string>();
  const CHUNK_SIZE = 500;
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunkKeys = candidates.slice(i, i + CHUNK_SIZE).map((o) => o.key);
    const rows = await prisma.recordingSegment.findMany({
      where: { objectKey: { in: chunkKeys } },
      select: { objectKey: true },
    });
    for (const row of rows) knownKeys.add(row.objectKey);
  }

  const orphans = candidates.filter((o) => !knownKeys.has(o.key));

  let deleted = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      await deleteStorageObject(orphan.key);
      deleted++;
      logger.warn(
        { objectKey: orphan.key, sizeBytes: orphan.sizeBytes, lastModified: orphan.lastModified },
        "deleted orphaned storage object with no matching recording_segments row",
      );
    } catch (err) {
      failed++;
      logger.error({ err, objectKey: orphan.key }, "failed to delete orphaned storage object — will retry next run");
    }
  }

  return { scanned: objects.length, orphaned: orphans.length, deleted, failed };
}
