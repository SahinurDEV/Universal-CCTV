import type { NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { dispatchNotificationToWebhooks } from "./webhooks.js";
import { logger } from "./logger.js";

/**
 * Creates a notification unless one of the same type+target was already
 * created within `cooldownMinutes` — this is the alert-storm guard. A
 * camera that stays offline through 100 consecutive health-check polls
 * produces one notification per cooldown window, not 100 identical rows.
 *
 * `targetId` is usually a camera id; pass `null` for tenant-wide conditions
 * (e.g. a storage quota warning) where there's no single target to key on.
 */
export async function notifyOnce(input: {
  tenantId: string;
  type: NotificationType;
  targetId: string | null;
  message: string;
  cooldownMinutes: number;
}): Promise<boolean> {
  const since = new Date(Date.now() - input.cooldownMinutes * 60 * 1000);

  const recent = await prisma.notification.findFirst({
    where: {
      tenantId: input.tenantId,
      type: input.type,
      targetId: input.targetId,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (recent) return false;

  const created = await prisma.notification.create({
    data: {
      tenantId: input.tenantId,
      type: input.type,
      targetId: input.targetId,
      message: input.message,
    },
  });
  // Fire-and-forget: a slow or broken webhook must never delay or fail the
  // worker job that raised the alert.
  void dispatchNotificationToWebhooks(created).catch((err) =>
    logger.warn({ err }, "webhook dispatch failed"),
  );
  return true;
}
