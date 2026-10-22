import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

export function platformAdminEmails(): Set<string> {
  const raw = loadEnv().PLATFORM_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A user is a platform admin if the DB flag is set (CLI) or their email is
 * listed in PLATFORM_ADMIN_EMAILS. Neither can be changed through the API. */
export function isPlatformAdminUser(user: { email: string; isPlatformAdmin: boolean }): boolean {
  return user.isPlatformAdmin || platformAdminEmails().has(user.email.toLowerCase());
}

export async function writePlatformAudit(entry: {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, Prisma.InputJsonValue>;
  ip?: string | null;
}): Promise<void> {
  // Unlike workspace audit logging, a failed admin audit write is surfaced to
  // the caller: admin actions must not happen unrecorded.
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata ?? undefined,
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, "failed to write platform audit log");
    throw err;
  }
}
