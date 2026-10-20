import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { deleteStorageObject } from "../lib/storage.js";
import { writeAuditLog } from "../lib/audit.js";

export interface RetentionResult {
  markedExpired: number;
  deleted: number;
  failed: number;
  /** Distinct tenants with at least one failed delete this run — so a
   * caller can notify the tenants that actually failed, not every tenant
   * with any lingering EXPIRED segment regardless of whether it was theirs
   * that failed. */
  failedTenantIds: string[];
}

/**
 * Enforces retention per docs/requirements.md §9/§10:
 *   1. Mark eligible — COMPLETE segments past their `retentionExpiresAt`
 *      become EXPIRED. A segment with `retentionExpiresAt: null` (no
 *      resolvable policy at ingest time — see recording/ingest.ts) is never
 *      selected here, by construction: an ambiguous/unset policy means
 *      "keep indefinitely," not "delete immediately."
 *   2. Delete the backing S3 object for every EXPIRED segment.
 *   3. Only on successful deletion, mark it DELETED.
 *   4. Audit log each deletion.
 *
 * Re-running this also IS the reconciliation step for previously-failed
 * deletes: a segment that failed to delete last time stays EXPIRED (never
 * silently reverted to COMPLETE), so the next run just retries it. There is
 * no separate "reconciliation job" because this function already is one.
 */
export async function enforceRetention(): Promise<RetentionResult> {
  const now = new Date();

  const markResult = await prisma.recordingSegment.updateMany({
    where: { status: "COMPLETE", retentionExpiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });

  const toDelete = await prisma.recordingSegment.findMany({
    where: { status: "EXPIRED" },
  });

  let deleted = 0;
  let failed = 0;
  const failedTenantIds = new Set<string>();

  for (const segment of toDelete) {
    try {
      await deleteStorageObject(segment.objectKey);
      await prisma.recordingSegment.update({
        where: { id: segment.id },
        data: { status: "DELETED" },
      });
      await writeAuditLog({
        tenantId: segment.tenantId,
        action: "recording.retention_delete",
        targetType: "RecordingSegment",
        targetId: segment.id,
        metadata: segment.retentionExpiresAt
          ? { cameraId: segment.cameraId, retentionExpiresAt: segment.retentionExpiresAt.toISOString() }
          : { cameraId: segment.cameraId },
      });
      deleted++;
    } catch (err) {
      failed++;
      failedTenantIds.add(segment.tenantId);
      logger.error({ err, segmentId: segment.id, objectKey: segment.objectKey }, "failed to delete expired recording segment — will retry next run");
    }
  }

  return { markedExpired: markResult.count, deleted, failed, failedTenantIds: [...failedTenantIds] };
}
