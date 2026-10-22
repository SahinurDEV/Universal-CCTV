import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { writeAuditLog } from "../lib/audit.js";
import { probeRateLimiter } from "../middleware/rateLimit.js";
import {
  WEBHOOK_EVENT_TYPES,
  UnsafeWebhookUrlError,
  assertSafeWebhookUrl,
  deliverWebhook,
  generateWebhookSecret,
} from "../lib/webhooks.js";

/**
 * Integrations. Implemented today: outbound **webhooks** — every new alert is
 * POSTed as signed JSON (HMAC-SHA256, header X-CCTV-Signature) to the URL.
 * That covers Slack/Teams/Discord relays, Zapier/Make/n8n, and custom
 * systems. Also listed (read-only) are the catalog items that are NOT built
 * yet, so the UI can be honest about them.
 * Managing integrations requires OWNER or ADMIN; any member may view them.
 */
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth, requireTenant);

const CATALOG = [
  { key: "webhook", name: "Webhook", status: "available", description: "Send every new alert as signed JSON to any URL (Zapier, Make, n8n, Slack relay, your own server)." },
  { key: "rtsp_onvif", name: "RTSP / ONVIF cameras", status: "built_in", description: "Connect almost any IP camera or NVR directly. Configure under Cameras." },
  { key: "email", name: "Email alerts", status: "planned", description: "Alert emails. Not available yet — use a webhook to an email service for now." },
  { key: "manufacturer_cloud", name: "Manufacturer clouds (Hik-Connect, Reolink Cloud, Tapo)", status: "planned", description: "Not available yet. Use the camera's RTSP stream instead." },
] as const;

const eventsSchema = z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length);
const createSchema = z.object({
  provider: z.literal("webhook"),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000),
  events: eventsSchema.optional(),
  isEnabled: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2000).optional(),
  events: eventsSchema.optional(),
  isEnabled: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
});

function serialize(row: {
  id: string;
  provider: string;
  name: string;
  config: unknown;
  isEnabled: boolean;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: string | null;
  createdAt: Date;
}) {
  const config = (row.config ?? {}) as { url?: string; events?: string[] };
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    url: config.url ?? null,
    events: config.events ?? [],
    isEnabled: row.isEnabled,
    lastDeliveryAt: row.lastDeliveryAt,
    lastDeliveryStatus: row.lastDeliveryStatus,
    createdAt: row.createdAt,
  };
}

function parseId(raw: string | undefined) {
  const r = z.string().uuid().safeParse(raw);
  return r.success ? r.data : null;
}

integrationsRouter.get("/", asyncHandler(async (req, res) => {
  const rows = await prisma.integrationConfig.findMany({
    where: { tenantId: req.authTenant!.id },
    orderBy: { createdAt: "asc" },
  });
  res.json({ catalog: CATALOG, eventTypes: WEBHOOK_EVENT_TYPES, integrations: rows.map(serialize) });
}));

integrationsRouter.post("/", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  try {
    await assertSafeWebhookUrl(parsed.data.url);
  } catch (err) {
    if (err instanceof UnsafeWebhookUrlError) return res.status(400).json({ error: "unsafe_url", message: err.message });
    throw err;
  }
  const count = await prisma.integrationConfig.count({ where: { tenantId: req.authTenant!.id } });
  if (count >= 20) return res.status(400).json({ error: "too_many_integrations" });

  const secret = generateWebhookSecret();
  const enc = encryptSecret(secret);
  const row = await prisma.integrationConfig.create({
    data: {
      tenantId: req.authTenant!.id,
      provider: "webhook",
      name: parsed.data.name,
      config: { url: parsed.data.url, events: parsed.data.events ?? [] },
      encryptedSecret: enc.ciphertext,
      secretIv: enc.iv,
      isEnabled: parsed.data.isEnabled ?? true,
    },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "integration.create",
    targetType: "IntegrationConfig",
    targetId: row.id,
    metadata: { provider: "webhook", name: row.name },
  });
  // The signing secret is shown exactly once, here.
  res.status(201).json({ ...serialize(row), signingSecret: secret });
}));

integrationsRouter.patch("/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "not_found" });
  const existing = await prisma.integrationConfig.findFirst({ where: { id, tenantId: req.authTenant!.id } });
  if (!existing) return res.status(404).json({ error: "not_found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  if (parsed.data.url) {
    try {
      await assertSafeWebhookUrl(parsed.data.url);
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) return res.status(400).json({ error: "unsafe_url", message: err.message });
      throw err;
    }
  }
  const config = (existing.config ?? {}) as { url?: string; events?: string[] };
  let newSecret: string | undefined;
  const data: Record<string, unknown> = {
    name: parsed.data.name ?? existing.name,
    isEnabled: parsed.data.isEnabled ?? existing.isEnabled,
    config: { url: parsed.data.url ?? config.url, events: parsed.data.events ?? config.events ?? [] },
  };
  if (parsed.data.rotateSecret) {
    newSecret = generateWebhookSecret();
    const enc = encryptSecret(newSecret);
    data.encryptedSecret = enc.ciphertext;
    data.secretIv = enc.iv;
  }
  const row = await prisma.integrationConfig.update({ where: { id: existing.id }, data });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "integration.update",
    targetType: "IntegrationConfig",
    targetId: row.id,
    metadata: { fields: Object.keys(parsed.data) },
  });
  res.json({ ...serialize(row), ...(newSecret ? { signingSecret: newSecret } : {}) });
}));

integrationsRouter.delete("/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "not_found" });
  const existing = await prisma.integrationConfig.findFirst({ where: { id, tenantId: req.authTenant!.id } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  await prisma.integrationConfig.delete({ where: { id: existing.id } });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "integration.delete",
    targetType: "IntegrationConfig",
    targetId: existing.id,
  });
  res.status(204).send();
}));

/** Sends a sample "test" event right now and reports the HTTP result. */
integrationsRouter.post("/:id/test", requireRole("OWNER", "ADMIN"), probeRateLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "not_found" });
  const existing = await prisma.integrationConfig.findFirst({ where: { id, tenantId: req.authTenant!.id } });
  if (!existing || !existing.encryptedSecret || !existing.secretIv) return res.status(404).json({ error: "not_found" });

  const secret = decryptSecret({ ciphertext: existing.encryptedSecret, iv: existing.secretIv });
  const config = existing.config as { url: string };
  const result = await deliverWebhook(config.url, secret, {
    event: "test",
    message: "This is a test event from Universal CCTV.",
    sentAt: new Date().toISOString(),
  });
  await prisma.integrationConfig.update({
    where: { id: existing.id },
    data: {
      lastDeliveryAt: new Date(),
      lastDeliveryStatus: result.ok ? `ok (${result.status})` : `failed (${result.status ?? result.error})`,
    },
  });
  res.json(result);
}));
