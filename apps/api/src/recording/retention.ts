import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { deleteStorageObject } from "../lib/storage.js";
import { writeAuditLog } from "../lib/audit.js";

export interface RetentionResult {
  markedExpired: number;
  /** DELETED tombstone rows removed from the database. */
  purgedRows: number;
  /** Motion events (and their snapshots) removed. */
  motionEventsDeleted: number;
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** Keep DELETED tombstones briefly (audit/debug), then drop the rows. */
const TOMBSTONE_KEEP_MS = DAY_MS;
/** Motion events/snapshots are kept this long when no retention is set. */
export const DEFAULT_MOTION_EVENT_RETENTION_DAYS = 30;

/** Camera override wins, then the workspace setting; null = no day-based
 * setting (segments then use the policy captured at ingest). */
export function effectiveRetentionDays(cameraOverride: number | null | undefined, workspaceDays: number | null | undefined): number | null {
  return cameraOverride ?? workspaceDays ?? null;
}

/** Applies workspace/camera retention-days settings: marks COMPLETE segments
 * older than the effective cutoff EXPIRED (and stamps retentionExpiresAt).
 * Settings apply retroactively — shortening retention cleans up old video
 * on the next run. */
export async function markExpiredBySettings(now = new Date()): Promise<number> {
  let marked = 0;
  const overrides = await prisma.camera.findMany({
    where: { retentionDaysOverride: { not: null } },
    select: { id: true, retentionDaysOverride: true },
  });
  for (const cam of overrides) {
    const cutoff = new Date(now.getTime() - cam.retentionDaysOverride! * DAY_MS);
    const r = await prisma.recordingSegment.updateMany({
      where: { cameraId: cam.id, status: "COMPLETE", startedAt: { lt: cutoff } },
      data: { status: "EXPIRED", retentionExpiresAt: now },
    });
    marked += r.count;
  }
  const tenants = await prisma.tenant.findMany({
    where: { retentionDays: { not: null } },
    select: { id: true, retentionDays: true },
  });
  for (const t of tenants) {
    const cutoff = new Date(now.getTime() - t.retentionDays! * DAY_MS);
    const r = await prisma.recordingSegment.updateMany({
      where: { tenantId: t.id, status: "COMPLETE", startedAt: { lt: cutoff }, camera: { retentionDaysOverride: null } },
      data: { status: "EXPIRED", retentionExpiresAt: now },
    });
    marked += r.count;
  }
  return marked;
}

/** Deletes motion events (and snapshot objects) older than the effective
 * retention for their camera (default 30 days). */
export async function cleanupMotionEvents(now = new Date()): Promise<number> {
  const cameras = await prisma.camera.findMany({
    where: { motionEvents: { some: {} } },
    select: { id: true, retentionDaysOverride: true, tenant: { select: { retentionDays: true } } },
  });
  let removed = 0;
  for (const cam of cameras) {
    const days = effectiveRetentionDays(cam.retentionDaysOverride, cam.tenant.retentionDays) ?? DEFAULT_MOTION_EVENT_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const old = await prisma.motionEvent.findMany({
      where: { cameraId: cam.id, detectedAt: { lt: cutoff } },
      select: { id: true, snapshotKey: true },
      take: 1000,
    });
    for (const ev of old) {
      try {
        if (ev.snapshotKey) await deleteStorageObject(ev.snapshotKey);
        await prisma.motionEvent.delete({ where: { id: ev.id } });
        removed++;
      } catch (err) {
        logger.warn({ err, motionEventId: ev.id }, "failed to delete expired motion event — will retry");
      }
    }
  }
  return removed;
}

export async function enforceRetention(): Promise<RetentionResult> {
  const now = new Date();

  const markedBySettings = await markExpiredBySettings(now);

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

  // Drop DELETED tombstones once their object has been gone a while: the
  // recording is removed from storage AND the database.
  const purge = await prisma.recordingSegment.deleteMany({
    where: { status: "DELETED", retentionExpiresAt: { lt: new Date(now.getTime() - TOMBSTONE_KEEP_MS) } },
  });
  const motionEventsDeleted = await cleanupMotionEvents(now);

  return {
    markedExpired: markResult.count + markedBySettings,
    purgedRows: purge.count,
    motionEventsDeleted,
    deleted,
    failed,
    failedTenantIds: [...failedTenantIds],
  };
}
