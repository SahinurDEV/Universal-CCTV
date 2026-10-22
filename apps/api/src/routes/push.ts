import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { probeRateLimiter } from "../middleware/rateLimit.js";
import { writeAuditLog } from "../lib/audit.js";
import { assertSafePushEndpoint, isPushConfigured, sendPush } from "../lib/push.js";

/**
 * Web Push device subscriptions — always the signed-in user's own devices.
 *   GET    /push/config            { enabled, publicKey }
 *   GET    /push/subscriptions     list my devices
 *   POST   /push/subscriptions     subscribe this device
 *   DELETE /push/subscriptions/:id remove one of my devices
 *   POST   /push/test              send a test push to all my devices
 */
export const pushRouter = Router();
pushRouter.use(requireAuth);

const MAX_SUBSCRIPTIONS_PER_USER = 20;
const b64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/);
const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: b64url.min(20).max(200), auth: b64url.min(8).max(100) }),
  userAgent: z.string().max(300).optional(),
});

function serialize(s: { id: string; endpoint: string; userAgent: string | null; createdAt: Date; lastSuccessAt: Date | null }) {
  let service = "unknown";
  try {
    service = new URL(s.endpoint).hostname;
  } catch {
    /* ignore */
  }
  // The full endpoint is a bearer-like capability URL; only show its host.
  return { id: s.id, service, userAgent: s.userAgent, createdAt: s.createdAt, lastSuccessAt: s.lastSuccessAt };
}

pushRouter.get("/config", (_req, res) => {
  const enabled = isPushConfigured();
  res.json({ enabled, publicKey: enabled ? loadEnv().VAPID_PUBLIC_KEY : null });
});

pushRouter.get("/subscriptions", asyncHandler(async (req, res) => {
  const subs = await prisma.pushSubscription.findMany({ where: { userId: req.authUser!.id }, orderBy: { createdAt: "desc" } });
  res.json({ enabled: isPushConfigured(), subscriptions: subs.map(serialize) });
}));

pushRouter.post("/subscriptions", probeRateLimiter, asyncHandler(async (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: "push_not_configured", message: "Push notifications are not set up on this server." });
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const { endpoint, keys, userAgent } = parsed.data;
  try {
    await assertSafePushEndpoint(endpoint);
  } catch {
    return res.status(400).json({ error: "invalid_endpoint", message: "That push endpoint is not allowed." });
  }
  const userId = req.authUser!.id;
  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint } });
  if (existing && existing.userId !== userId) {
    // Same browser, different account signed in now: move it.
    await prisma.pushSubscription.delete({ where: { id: existing.id } });
  }
  const count = await prisma.pushSubscription.count({ where: { userId, NOT: { endpoint } } });
  if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
    return res.status(409).json({ error: "too_many_devices", message: `Remove a device first (max ${MAX_SUBSCRIPTIONS_PER_USER}).` });
  }
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent ?? null },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent ?? null },
  });
  if (req.authSession?.activeTenantId) {
    await writeAuditLog({ tenantId: req.authSession.activeTenantId, actorUserId: userId, action: "push.subscribe", targetType: "PushSubscription", targetId: sub.id });
  }
  res.status(201).json(serialize(sub));
}));

pushRouter.delete("/subscriptions/:id", asyncHandler(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const removed = await prisma.pushSubscription.deleteMany({ where: { id: id.data, userId: req.authUser!.id } });
  if (removed.count === 0) return res.status(404).json({ error: "not_found" });
  res.status(204).send();
}));

pushRouter.post("/test", probeRateLimiter, asyncHandler(async (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: "push_not_configured" });
  const subs = await prisma.pushSubscription.findMany({ where: { userId: req.authUser!.id } });
  let sent = 0;
  for (const s of subs) {
    if (await sendPush(s, { title: "Universal CCTV", body: "Test notification — push is working.", url: "/dashboard/settings", tag: "test" })) sent++;
  }
  res.json({ devices: subs.length, sent });
}));
