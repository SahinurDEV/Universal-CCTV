import webpush from "web-push";
import type { NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";
import { mutedTypesFrom } from "./notification-prefs.js";
import { assertSafeWebhookUrl } from "./webhooks.js";
import { dispatchNotificationToFcm } from "./fcm.js";

let configured: boolean | undefined;

/** True only when BOTH VAPID keys are set and valid. Missing/invalid keys
 * disable push quietly; nothing else in the app depends on it. */
export function isPushConfigured(): boolean {
  if (configured !== undefined) return configured;
  const env = loadEnv();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    configured = false;
    return configured;
  }
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "invalid VAPID configuration — web push disabled");
    configured = false;
  }
  return configured;
}

/** Browser push services only. Blocks SSRF via a crafted "endpoint". */
export async function assertSafePushEndpoint(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Push endpoint must use https://");
  await assertSafeWebhookUrl(endpoint);
}

export const PUSH_TITLES: Record<NotificationType, string> = {
  CAMERA_OFFLINE: "Camera offline",
  RECORDING_STOPPED: "Recording stopped",
  STORAGE_QUOTA_WARNING: "Storage almost full",
  UPLOAD_FAILURE: "Upload failed",
  RETENTION_CLEANUP_FAILURE: "Cleanup failed",
  MOTION_DETECTED: "Motion detected",
  PERSON_DETECTED: "Person detected",
  VEHICLE_DETECTED: "Vehicle detected",
};

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one payload; deletes subscriptions the push service says are gone. */
export async function sendPush(sub: PushTarget, payload: object): Promise<boolean> {
  if (!isPushConfigured()) return false;
  try {
    await assertSafePushEndpoint(sub.endpoint);
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600, timeout: 10_000 },
    );
    await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: new Date() } }).catch(() => undefined);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
    } else {
      logger.warn({ subscriptionId: sub.id, status, err: err instanceof Error ? err.message : err }, "push send failed");
    }
    return false;
  }
}

/** Fans a new alert out to every device of every workspace member who
 * hasn't muted that alert type (same preferences as the in-app list). */
export async function dispatchNotificationToPush(n: {
  id: string;
  tenantId: string;
  type: NotificationType;
  message: string;
  targetId: string | null;
  eventId?: string | null;
}): Promise<number> {
  // Native apps (FCM) and browsers (Web Push) are independent; either may be
  // configured without the other.
  const fcmSent = await dispatchNotificationToFcm(n, PUSH_TITLES[n.type] ?? "Alert").catch((err) => {
    logger.warn({ err }, "FCM dispatch failed");
    return 0;
  });
  if (!isPushConfigured()) return fcmSent;
  const members = await prisma.membership.findMany({
    where: { tenantId: n.tenantId },
    select: { notificationPreferences: true, user: { select: { pushSubscriptions: true } } },
  });
  const payload = {
    title: PUSH_TITLES[n.type] ?? "Alert",
    body: n.message,
    tag: `${n.type}:${n.targetId ?? "all"}`,
    url: n.targetId && n.type.endsWith("_DETECTED") ? `/dashboard/cameras/${n.targetId}` : "/dashboard/alerts",
    notificationId: n.id,
  };
  let sent = 0;
  for (const m of members) {
    if (mutedTypesFrom(m.notificationPreferences).includes(n.type)) continue;
    for (const sub of m.user.pushSubscriptions) {
      if (await sendPush(sub, payload)) sent++;
    }
  }
  return sent + fcmSent;
}

export function resetPushConfigForTests() {
  configured = undefined;
}
