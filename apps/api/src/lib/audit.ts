import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, Prisma.InputJsonValue>;
}

/**
 * Audit logging never throws into the caller's request path — a failed audit
 * write shouldn't fail the user-facing operation it's recording, it just gets
 * logged for an operator to notice. Never pass credentials/RTSP URLs in
 * `metadata`.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata ?? undefined,
      },
    });
  } catch (err) {
    logger.error({ err, entry: { ...entry, metadata: undefined } }, "failed to write audit log");
  }
}
