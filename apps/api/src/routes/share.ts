import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { loadEnv } from "../env.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, fetchHlsResource } from "../connectors/mediamtx-client.js";
import { getSignedPlaybackUrl } from "../lib/storage.js";
import { logger } from "../lib/logger.js";
import { hasControlChars } from "../lib/validation.js";
import { createLinkToken, createViewToken, hashLinkToken, verifyLinkToken, verifyViewToken } from "../lib/share-tokens.js";

/**
 * Share links.
 * Authenticated (Operator+):
 *   POST   /cameras/:id/shares   create (token returned once)
 *   GET    /shares               list workspace links (no tokens)
 *   DELETE /shares/:id           revoke
 * Public (no login, strictly scoped to the one shared item):
 *   POST   /public/share/:token/open        {password?} -> metadata + view token
 *   GET    /public/share/v/:view/hls/:file  live HLS for that camera only
 *   GET    /public/share/v/:view/clip       signed URLs for segments in range only
 */
export const shareAdminRouter = Router();
export const cameraShareRouter = Router();
export const publicShareRouter = Router();

const operator = requireRole("OWNER", "ADMIN", "OPERATOR");
const auth = [requireAuth, requireTenant];
const idSchema = z.string().uuid();
const MAX_CLIP_MS = 60 * 60 * 1000;
const MAX_EXPIRY_MIN = 7 * 24 * 60;

export const shareOpenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
export const shareStreamRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
const shareCreateRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.authUser?.id ?? "anon"}`,
  message: { error: "too_many_requests" },
});

const createSchema = z
  .object({
    kind: z.enum(["LIVE", "CLIP"]),
    clipStart: z.coerce.date().optional(),
    clipEnd: z.coerce.date().optional(),
    expiresInMinutes: z.number().int().min(5).max(MAX_EXPIRY_MIN),
    password: z.string().min(6).max(128).optional(),
    maxViews: z.number().int().min(1).max(1000).optional(),
    label: z.string().trim().max(80).refine((v) => !hasControlChars(v) && !/[<>]/.test(v), "invalid label").optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === "CLIP") {
      if (!v.clipStart || !v.clipEnd) return ctx.addIssue({ code: "custom", message: "clipStart and clipEnd are required" });
      if (v.clipEnd <= v.clipStart) ctx.addIssue({ code: "custom", message: "clipEnd must be after clipStart" });
      if (v.clipEnd.getTime() - v.clipStart.getTime() > MAX_CLIP_MS) ctx.addIssue({ code: "custom", message: "clip is longer than 1 hour" });
      if (v.clipStart.getTime() > Date.now()) ctx.addIssue({ code: "custom", message: "clip must be in the past" });
    } else if (v.clipStart || v.clipEnd) {
      ctx.addIssue({ code: "custom", message: "live links take no clip range" });
    }
  });

function ip(req: Request): string {
  return (req.ip ?? "").slice(0, 64);
}

function serialize(l: {
  id: string; cameraId: string; kind: string; clipStart: Date | null; clipEnd: Date | null; label: string | null;
  passwordHash: string | null; maxViews: number | null; viewCount: number; expiresAt: Date; revokedAt: Date | null;
  lastViewedAt: Date | null; createdAt: Date; createdById: string | null; camera?: { name: string };
}) {
  const now = Date.now();
  const status = l.revokedAt ? "revoked" : l.expiresAt.getTime() <= now ? "expired" : l.maxViews !== null && l.viewCount >= l.maxViews ? "used_up" : "active";
  return {
    id: l.id, cameraId: l.cameraId, cameraName: l.camera?.name, kind: l.kind, clipStart: l.clipStart, clipEnd: l.clipEnd,
    label: l.label, hasPassword: Boolean(l.passwordHash), maxViews: l.maxViews, viewCount: l.viewCount,
    expiresAt: l.expiresAt, revokedAt: l.revokedAt, lastViewedAt: l.lastViewedAt, createdAt: l.createdAt,
    createdById: l.createdById, status,
  };
}

cameraShareRouter.post("/:id/shares", ...auth, operator, shareCreateRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const body = createSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "invalid_request", message: body.error.issues[0]?.message });
  const camera = await prisma.camera.findFirst({ where: { id: id.data, tenantId: req.authTenant!.id }, select: { id: true, name: true } });
  if (!camera) return res.status(404).json({ error: "not_found" });
  const { token, hash } = createLinkToken();
  const d = body.data;
  const link = await prisma.shareLink.create({
    data: {
      tenantId: req.authTenant!.id, cameraId: camera.id, createdById: req.authUser!.id, kind: d.kind,
      clipStart: d.clipStart ?? null, clipEnd: d.clipEnd ?? null, label: d.label || null, tokenHash: hash,
      passwordHash: d.password ? await hashPassword(d.password) : null, maxViews: d.maxViews ?? null,
      expiresAt: new Date(Date.now() + d.expiresInMinutes * 60_000),
    },
    include: { camera: { select: { name: true } } },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id, actorUserId: req.authUser!.id, action: "share.create", targetType: "ShareLink", targetId: link.id,
    metadata: { cameraId: camera.id, kind: d.kind, expiresInMinutes: d.expiresInMinutes, password: Boolean(d.password), maxViews: d.maxViews ?? 0 },
  });
  const url = `${loadEnv().APP_PUBLIC_URL.replace(/\/$/, "")}/share/${token}`;
  res.status(201).json({ ...serialize(link), token, url });
}));

shareAdminRouter.use(...auth, operator);

shareAdminRouter.get("/", asyncHandler(async (req, res) => {
  const cameraId = idSchema.safeParse(req.query.cameraId);
  const links = await prisma.shareLink.findMany({
    where: { tenantId: req.authTenant!.id, ...(cameraId.success ? { cameraId: cameraId.data } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { camera: { select: { name: true } } },
  });
  res.json({ links: links.map(serialize) });
}));

shareAdminRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const link = await prisma.shareLink.findFirst({ where: { id: id.data, tenantId: req.authTenant!.id } });
  if (!link) return res.status(404).json({ error: "not_found" });
  // Operators may revoke only their own links; Admins/Owners any.
  if (req.authTenant!.role === "OPERATOR" && link.createdById !== req.authUser!.id) return res.status(403).json({ error: "forbidden" });
  if (!link.revokedAt) {
    await prisma.shareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    await writeAuditLog({ tenantId: link.tenantId, actorUserId: req.authUser!.id, action: "share.revoke", targetType: "ShareLink", targetId: link.id });
  }
  res.status(204).send();
}));

// --- Public ---------------------------------------------------------------

const GONE = { error: "link_unavailable" } as const; // one answer for unknown/expired/revoked/used up

function usable(l: { revokedAt: Date | null; expiresAt: Date }) {
  return !l.revokedAt && l.expiresAt.getTime() > Date.now();
}

publicShareRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  next();
});

publicShareRouter.post("/:token/open", shareOpenRateLimiter, asyncHandler(async (req, res) => {
  const token = String(req.params.token ?? "");
  if (!verifyLinkToken(token)) return res.status(404).json(GONE);
  const link = await prisma.shareLink.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { camera: { select: { name: true } }, tenant: { select: { suspendedAt: true } } } });
  // Suspended workspaces (platform admin) can't be reached through share links either.
  if (!link || !usable(link) || link.tenant.suspendedAt) return res.status(404).json(GONE);
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return res.status(404).json(GONE);
  const password = typeof req.body?.password === "string" ? req.body.password.slice(0, 128) : "";
  if (link.passwordHash) {
    if (!password) return res.status(401).json({ error: "password_required", kind: link.kind });
    if (!(await verifyPassword(password, link.passwordHash))) {
      await writeAuditLog({ tenantId: link.tenantId, action: "share.password_failed", targetType: "ShareLink", targetId: link.id, metadata: { ip: ip(req) } });
      return res.status(401).json({ error: "wrong_password", kind: link.kind });
    }
  }
  // Atomic view counting: never exceeds maxViews even under concurrent opens.
  const counted = await prisma.shareLink.updateMany({
    where: { id: link.id, revokedAt: null, expiresAt: { gt: new Date() }, ...(link.maxViews !== null ? { viewCount: { lt: link.maxViews } } : {}) },
    data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
  });
  if (counted.count === 0) return res.status(404).json(GONE);

  if (link.kind === "LIVE") {
    const camera = await prisma.camera.findUnique({ where: { id: link.cameraId }, include: { credential: true } });
    const source = camera ? await resolveCameraRtspUrl(camera) : null;
    if (!source?.ok) return res.status(502).json({ error: "live_unavailable" });
    try {
      await ensureLivePath(link.cameraId, source.rtspUrl);
    } catch (err) {
      logger.warn({ err, linkId: link.id }, "share live path failed");
      return res.status(502).json({ error: "live_unavailable" });
    }
  }
  const view = createViewToken(link.id, link.expiresAt);
  await writeAuditLog({ tenantId: link.tenantId, action: "share.view", targetType: "ShareLink", targetId: link.id, metadata: { ip: ip(req), cameraId: link.cameraId } });
  res.json({
    kind: link.kind, cameraName: link.camera.name, label: link.label, clipStart: link.clipStart, clipEnd: link.clipEnd,
    expiresAt: link.expiresAt, viewToken: view.token, viewTokenExpiresAt: view.expiresAt,
    playlistUrl: link.kind === "LIVE" ? `/public/share/v/${view.token}/hls/index.m3u8` : null,
    clipUrl: link.kind === "CLIP" ? `/public/share/v/${view.token}/clip` : null,
  });
}));

async function linkForView(viewToken: string, kind: "LIVE" | "CLIP") {
  const v = verifyViewToken(viewToken);
  if (!v) return null;
  const link = await prisma.shareLink.findUnique({ where: { id: v.linkId }, include: { tenant: { select: { suspendedAt: true } } } });
  if (!link || link.kind !== kind || !usable(link) || link.tenant.suspendedAt) return null;
  return link;
}

const HLS_FILE_RE = /^[A-Za-z0-9_-]{1,100}\.(m3u8|ts|mp4|m4s)$/;
const CONTENT_TYPES: Record<string, string> = { m3u8: "application/vnd.apple.mpegurl", ts: "video/mp2t", mp4: "video/mp4", m4s: "video/iso.segment" };

publicShareRouter.get("/v/:view/hls/:file", shareStreamRateLimiter, asyncHandler(async (req, res) => {
  const { view, file } = req.params as { view: string; file: string };
  if (!HLS_FILE_RE.test(file)) return res.status(404).json(GONE);
  const link = await linkForView(view, "LIVE");
  if (!link) return res.status(404).json(GONE);
  const qs = new URLSearchParams();
  for (const key of ["session", "_HLS_msn", "_HLS_part", "_HLS_skip"]) {
    const v = req.query[key];
    if (typeof v === "string" && /^[A-Za-z0-9-]{1,40}$/.test(v)) qs.set(key, v);
  }
  const search = qs.toString() ? `?${qs}` : "";
  let upstream: Response;
  try {
    upstream = await fetchHlsResource(link.cameraId, file, search);
  } catch {
    return res.status(502).json({ error: "live_unavailable" });
  }
  if (!upstream.ok || !upstream.body) return res.status(upstream.status === 404 ? 404 : 502).json({ error: "live_unavailable" });
  const ext = file.split(".").pop()!;
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
}));

publicShareRouter.get("/v/:view/clip", shareStreamRateLimiter, asyncHandler(async (req, res) => {
  const link = await linkForView(String(req.params.view), "CLIP");
  if (!link || !link.clipStart || !link.clipEnd) return res.status(404).json(GONE);
  // Only segments overlapping the shared range, from that one camera.
  const segments = await prisma.recordingSegment.findMany({
    where: {
      cameraId: link.cameraId, tenantId: link.tenantId, status: "COMPLETE",
      startedAt: { lt: link.clipEnd, gte: new Date(link.clipStart.getTime() - 10 * 60_000) },
    },
    orderBy: { startedAt: "asc" },
    take: 120,
  });
  const inRange = segments.filter((s) => {
    const end = s.endedAt ?? new Date(s.startedAt.getTime() + (s.durationSec ?? 60) * 1000);
    return end > link.clipStart! && s.startedAt < link.clipEnd!;
  });
  const items = await Promise.all(
    inRange.map(async (s) => ({
      startedAt: s.startedAt,
      durationSec: s.durationSec,
      // Seconds to skip at the start / stop at, so playback is trimmed to the range.
      offsetSec: Math.max(0, (link.clipStart!.getTime() - s.startedAt.getTime()) / 1000),
      untilSec: Math.max(0, (link.clipEnd!.getTime() - s.startedAt.getTime()) / 1000),
      url: await getSignedPlaybackUrl(s.objectKey),
    })),
  );
  res.json({ clipStart: link.clipStart, clipEnd: link.clipEnd, segments: items, urlExpiresInSeconds: loadEnv().SIGNED_URL_TTL_SECONDS });
}));
