import { readFileSync } from "node:fs";
import type { NotificationType } from "@prisma/client";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { mutedTypesFrom } from "./notification-prefs.js";

type Messaging = import("firebase-admin/messaging").Messaging;

export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  android?: object;
  apns?: object;
}

/** Minimal sender interface so tests can inject a fake. */
export interface FcmSender {
  send(message: FcmMessage): Promise<string>;
}

let sender: FcmSender | null | undefined;

function loadServiceAccount(): object | null {
  const env = loadEnv();
  try {
    if (env.FCM_SERVICE_ACCOUNT_BASE64) return JSON.parse(Buffer.from(env.FCM_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
    if (env.FCM_SERVICE_ACCOUNT_FILE) return JSON.parse(readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, "utf8"));
  } catch (err) {
    // Never log the credential content, only that it was unusable.
    logger.warn({ err: err instanceof Error ? err.name : "error" }, "invalid FCM service account — FCM disabled");
  }
  return null;
}

/** Returns the FCM sender, or null when FCM isn't configured (disabled). */
export async function getFcmSender(): Promise<FcmSender | null> {
  if (sender !== undefined) return sender;
  const account = loadServiceAccount();
  if (!account) {
    sender = null;
    return sender;
  }
  try {
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");
    const app = getApps().find((a) => a.name === "cctv-fcm") ?? initializeApp({ credential: cert(account as never) }, "cctv-fcm");
    const messaging: Messaging = getMessaging(app);
    sender = { send: (m) => messaging.send(m) };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "FCM init failed — FCM disabled");
    sender = null;
  }
  return sender;
}

export async function isFcmConfigured(): Promise<boolean> {
  return (await getFcmSender()) !== null;
}

/** Test hook. */
export function setFcmSenderForTests(s: FcmSender | null | undefined) {
  sender = s;
}

const GONE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** Sends an alert to every native device of every member who hasn't muted
 * the type. Only tokens whose registering session is still valid are used,
 * so logout / revoked sessions stop pushes. Dead tokens are deleted. */
export async function dispatchNotificationToFcm(
  n: { id: string; tenantId: string; type: NotificationType; message: string; targetId: string | null; eventId?: string | null },
  title: string,
): Promise<number> {
  const s = await getFcmSender();
  if (!s) return 0;
  const now = new Date();
  const members = await prisma.membership.findMany({
    where: { tenantId: n.tenantId },
    select: {
      notificationPreferences: true,
      user: {
        select: {
          fcmTokens: {
            where: { OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] },
          },
        },
      },
    },
  });
  let sent = 0;
  for (const m of members) {
    if (mutedTypesFrom(m.notificationPreferences).includes(n.type)) continue;
    for (const t of m.user.fcmTokens) {
      try {
        await s.send({
          token: t.token,
          notification: { title, body: n.message },
          data: {
            notificationId: n.id,
            type: n.type,
            tenantId: n.tenantId,
            cameraId: n.targetId ?? "",
            eventId: n.eventId ?? "",
          },
          android: { priority: "high", notification: { channelId: "alerts" } },
          apns: { payload: { aps: { sound: "default" } } },
        });
        sent++;
        await prisma.fcmToken.update({ where: { id: t.id }, data: { lastSuccessAt: new Date() } }).catch(() => undefined);
      } catch (err) {
        const code = (err as { code?: string; errorInfo?: { code?: string } }).errorInfo?.code ?? (err as { code?: string }).code;
        if (code && GONE_CODES.has(code)) {
          await prisma.fcmToken.delete({ where: { id: t.id } }).catch(() => undefined);
        } else {
          logger.warn({ tokenId: t.id, code }, "FCM send failed");
        }
      }
    }
  }
  return sent;
}
