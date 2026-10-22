import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { assertSafeResolvedCameraHost, UnsafeCameraHostError } from "./network-guard.js";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

export class UnsafeWebhookUrlError extends Error {}

export const WEBHOOK_EVENT_TYPES = [
  "CAMERA_OFFLINE",
  "RECORDING_STOPPED",
  "STORAGE_QUOTA_WARNING",
  "UPLOAD_FAILURE",
  "RETENTION_CLEANUP_FAILURE",
  "MOTION_DETECTED",
  "PERSON_DETECTED",
  "VEHICLE_DETECTED",
] as const;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * SSRF guard for user-supplied webhook URLs: http(s) only (https only in
 * production), no embedded credentials, and the host — after DNS resolution
 * — must not be loopback/link-local/metadata (private ranges are also
 * blocked in production). Same address rules as camera hosts.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError("Webhook URL is not a valid URL.");
  }
  const prod = loadEnv().NODE_ENV === "production";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !prod)) {
    throw new UnsafeWebhookUrlError(prod ? "Webhook URL must use https://." : "Webhook URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new UnsafeWebhookUrlError("Webhook URL must not contain a username or password.");
  }
  try {
    await assertSafeResolvedCameraHost(url.hostname);
  } catch (err) {
    if (err instanceof UnsafeCameraHostError) throw new UnsafeWebhookUrlError(err.message.replace("Host", "Webhook host"));
    throw err;
  }
  if (prod && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
    throw new UnsafeWebhookUrlError("Webhook host must be a public address.");
  }
  return url;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookDeliveryResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/** POSTs one signed JSON payload. Never follows redirects (a redirect to an
 * internal address would bypass the URL check). 5 s timeout. */
export async function deliverWebhook(urlRaw: string, secret: string, payload: unknown): Promise<WebhookDeliveryResult> {
  let url: URL;
  try {
    url = await assertSafeWebhookUrl(urlRaw);
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "invalid url" };
  }
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "UniversalCCTV-Webhook/1.0",
        "X-CCTV-Timestamp": timestamp,
        "X-CCTV-Signature": `sha256=${signPayload(secret, timestamp, body)}`,
      },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.name : "request failed" };
  }
}

interface WebhookConfig {
  url: string;
  events?: string[];
}

/** Fans a new alert out to every enabled webhook of the tenant that
 * subscribed to its type. Best-effort: failures are recorded on the
 * integration row and never thrown to the caller. */
export async function dispatchNotificationToWebhooks(notification: {
  id: string;
  tenantId: string;
  type: string;
  targetId: string | null;
  message: string;
  createdAt: Date;
}): Promise<void> {
  const integrations = await prisma.integrationConfig.findMany({
    where: { tenantId: notification.tenantId, provider: "webhook", isEnabled: true },
  });
  await Promise.all(
    integrations.map(async (integration) => {
      const config = integration.config as unknown as WebhookConfig;
      if (config.events?.length && !config.events.includes(notification.type)) return;
      if (!integration.encryptedSecret || !integration.secretIv) return;
      let secret: string;
      try {
        secret = decryptSecret({ ciphertext: integration.encryptedSecret, iv: integration.secretIv });
      } catch {
        return;
      }
      const result = await deliverWebhook(config.url, secret, {
        event: "alert.created",
        alert: {
          id: notification.id,
          type: notification.type,
          targetId: notification.targetId,
          message: notification.message,
          createdAt: notification.createdAt.toISOString(),
        },
      });
      await prisma.integrationConfig
        .update({
          where: { id: integration.id },
          data: {
            lastDeliveryAt: new Date(),
            lastDeliveryStatus: result.ok ? `ok (${result.status})` : `failed (${result.status ?? result.error})`,
          },
        })
        .catch(() => undefined);
      if (!result.ok) {
        logger.warn({ integrationId: integration.id, status: result.status }, "webhook delivery failed");
      }
    }),
  );
}
