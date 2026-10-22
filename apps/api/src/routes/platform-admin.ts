import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requirePlatformAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { adminActionRateLimiter } from "../middleware/rateLimit.js";
import { hasControlChars } from "../lib/validation.js";
import { isPlatformAdminUser, platformAdminEmails } from "../lib/platform-admin.js";

/**
 * Platform super-admin API (operator of the whole service). Every route
 * requires requireAuth + requirePlatformAdmin; workspace roles play no part.
 * Read routes never return secrets (password hashes, camera credentials,
 * hosts' RTSP paths, session tokens).
 */
export const platformAdminRouter = Router();
platformAdminRouter.use(requireAuth, requirePlatformAdmin);

const idSchema = z.string().uuid();
const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .refine((v) => !hasControlChars(v), "invalid characters"),
});

const now = () => new Date();
const activeSessionWhere = () => ({ revokedAt: null, expiresAt: { gt: now() } });

async function storageByTenant(tenantIds?: string[]) {
  const rows = await prisma.recordingSegment.groupBy({
    by: ["tenantId"],
    where: { status: "COMPLETE", ...(tenantIds ? { tenantId: { in: tenantIds } } : {}) },
    _sum: { fileSizeBytes: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.tenantId, { bytes: Number(r._sum.fileSizeBytes ?? 0n), segments: r._count._all }]));
}

platformAdminRouter.get("/stats", asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [tenants, suspendedTenants, users, suspendedUsers, cameras, recordingNow, storage, segments, alerts, alerts24h, sessions, mobileSessions] =
    await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { suspendedAt: { not: null } } }),
      prisma.user.count(),
      prisma.user.count({ where: { suspendedAt: { not: null } } }),
      prisma.camera.count(),
      prisma.recordingJob.count({ where: { status: "RUNNING" } }),
      prisma.recordingSegment.aggregate({ where: { status: "COMPLETE" }, _sum: { fileSizeBytes: true } }),
      prisma.recordingSegment.count({ where: { status: "COMPLETE" } }),
      prisma.notification.count(),
      prisma.notification.count({ where: { createdAt: { gte: since } } }),
      prisma.session.count({ where: activeSessionWhere() }),
      prisma.session.count({ where: { ...activeSessionWhere(), clientType: "mobile" } }),
    ]);
  res.json({
    tenants: { total: tenants, suspended: suspendedTenants },
    users: { total: users, suspended: suspendedUsers },
    cameras: { total: cameras, recording: recordingNow },
    storage: { bytes: Number(storage._sum.fileSizeBytes ?? 0n) },
    recordings: { segments },
    alerts: { total: alerts, last24h: alerts24h },
    sessions: { active: sessions, mobile: mobileSessions },
  });
}));

platformAdminRouter.get("/tenants", asyncHandler(async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const { q: search, page, pageSize } = q.data;
  const where: Prisma.TenantWhereInput = search ? { name: { contains: search, mode: "insensitive" } } : {};
  const [total, tenants] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { memberships: true, cameras: true, notifications: true } } },
    }),
  ]);
  const storage = await storageByTenant(tenants.map((t) => t.id));
  res.json({
    total,
    page,
    pageSize,
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      suspendedAt: t.suspendedAt,
      suspendedReason: t.suspendedReason,
      members: t._count.memberships,
      cameras: t._count.cameras,
      alerts: t._count.notifications,
      storageBytes: storage.get(t.id)?.bytes ?? 0,
      segments: storage.get(t.id)?.segments ?? 0,
    })),
  });
}));

platformAdminRouter.get("/tenants/:id", asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const t = await prisma.tenant.findUnique({
    where: { id: id.data },
    include: {
      memberships: { include: { user: { select: { id: true, email: true, displayName: true, suspendedAt: true } } } },
      cameras: { select: { id: true, name: true, connectorType: true, motionEnabled: true, createdAt: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1, include: { plan: { select: { key: true, name: true } } } },
    },
  });
  if (!t) return res.status(404).json({ error: "not_found" });
  const storage = await storageByTenant([t.id]);
  res.json({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt,
    suspendedAt: t.suspendedAt,
    suspendedReason: t.suspendedReason,
    plan: t.subscriptions[0]?.plan ?? null,
    storageBytes: storage.get(t.id)?.bytes ?? 0,
    segments: storage.get(t.id)?.segments ?? 0,
    members: t.memberships.map((m) => ({ ...m.user, role: m.role })),
    cameras: t.cameras,
  });
}));

platformAdminRouter.get("/users", asyncHandler(async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const { q: search, page, pageSize } = q.data;
  const where: Prisma.UserWhereInput = search
    ? { OR: [{ email: { contains: search, mode: "insensitive" } }, { displayName: { contains: search, mode: "insensitive" } }] }
    : {};
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        suspendedAt: true,
        suspendedReason: true,
        isPlatformAdmin: true,
        memberships: { select: { role: true, tenant: { select: { id: true, name: true } } } },
        _count: { select: { sessions: { where: activeSessionWhere() } } },
      },
    }),
  ]);
  res.json({
    total,
    page,
    pageSize,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      createdAt: u.createdAt,
      suspendedAt: u.suspendedAt,
      suspendedReason: u.suspendedReason,
      isPlatformAdmin: isPlatformAdminUser(u),
      activeSessions: u._count.sessions,
      workspaces: u.memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
    })),
  });
}));

platformAdminRouter.get("/cameras", asyncHandler(async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const { q: search, page, pageSize } = q.data;
  const where: Prisma.CameraWhereInput = search ? { name: { contains: search, mode: "insensitive" } } : {};
  const [total, cameras] = await Promise.all([
    prisma.camera.count({ where }),
    prisma.camera.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        connectorType: true,
        manufacturer: true,
        model: true,
        motionEnabled: true,
        createdAt: true,
        tenant: { select: { id: true, name: true, suspendedAt: true } },
        recordingJobs: { where: { status: "RUNNING" }, select: { id: true }, take: 1 },
        _count: { select: { motionEvents: true } },
      },
    }),
  ]);
  res.json({
    total,
    page,
    pageSize,
    cameras: cameras.map((c) => ({
      id: c.id,
      name: c.name,
      connectorType: c.connectorType,
      manufacturer: c.manufacturer,
      model: c.model,
      motionEnabled: c.motionEnabled,
      createdAt: c.createdAt,
      tenant: c.tenant,
      recording: c.recordingJobs.length > 0,
      motionEvents: c._count.motionEvents,
    })),
  });
}));

platformAdminRouter.get("/audit", asyncHandler(async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "invalid_request", details: q.error.issues });
  const rows = await prisma.platformAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    skip: (q.data.page - 1) * q.data.pageSize,
    take: q.data.pageSize,
    include: { actor: { select: { email: true } } },
  });
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      actorEmail: r.actor?.email ?? null,
      createdAt: r.createdAt,
    })),
  });
}));

function audit(tx: Prisma.TransactionClient, actorUserId: string, ip: string | undefined, action: string, targetType: string, targetId: string, metadata: Record<string, string | null>) {
  return tx.platformAuditLog.create({ data: { actorUserId, action, targetType, targetId, metadata, ip: ip ?? null } });
}

platformAdminRouter.post("/tenants/:id/suspend", adminActionRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const body = reasonSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_request", details: body.error.issues });
  const tenant = await prisma.tenant.findUnique({ where: { id: id.data } });
  if (!tenant) return res.status(404).json({ error: "not_found" });
  if (tenant.suspendedAt) return res.status(409).json({ error: "already_suspended" });
  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.update({ where: { id: tenant.id }, data: { suspendedAt: now(), suspendedReason: body.data.reason } });
    await audit(tx, req.authUser!.id, req.ip, "tenant.suspend", "Tenant", tenant.id, { reason: body.data.reason, name: tenant.name });
    return t;
  });
  res.json({ id: updated.id, suspendedAt: updated.suspendedAt, suspendedReason: updated.suspendedReason });
}));

platformAdminRouter.post("/tenants/:id/unsuspend", adminActionRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const tenant = await prisma.tenant.findUnique({ where: { id: id.data } });
  if (!tenant) return res.status(404).json({ error: "not_found" });
  if (!tenant.suspendedAt) return res.status(409).json({ error: "not_suspended" });
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenant.id }, data: { suspendedAt: null, suspendedReason: null } });
    await audit(tx, req.authUser!.id, req.ip, "tenant.unsuspend", "Tenant", tenant.id, { name: tenant.name });
  });
  res.json({ id: tenant.id, suspendedAt: null });
}));

platformAdminRouter.post("/users/:id/suspend", adminActionRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const body = reasonSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_request", details: body.error.issues });
  if (id.data === req.authUser!.id) return res.status(400).json({ error: "cannot_suspend_self" });
  const user = await prisma.user.findUnique({ where: { id: id.data } });
  if (!user) return res.status(404).json({ error: "not_found" });
  // Admins can't lock each other out via the API; use the CLI to revoke first.
  if (isPlatformAdminUser(user)) return res.status(403).json({ error: "cannot_suspend_platform_admin" });
  if (user.suspendedAt) return res.status(409).json({ error: "already_suspended" });
  const revoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { suspendedAt: now(), suspendedReason: body.data.reason } });
    // Kill every live session (web + mobile) and native push registrations.
    const r = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now() } });
    await tx.fcmToken.deleteMany({ where: { userId: user.id } });
    await audit(tx, req.authUser!.id, req.ip, "user.suspend", "User", user.id, { reason: body.data.reason, email: user.email });
    return r.count;
  });
  res.json({ id: user.id, suspended: true, sessionsRevoked: revoked });
}));

platformAdminRouter.post("/users/:id/unsuspend", adminActionRateLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const user = await prisma.user.findUnique({ where: { id: id.data } });
  if (!user) return res.status(404).json({ error: "not_found" });
  if (!user.suspendedAt) return res.status(409).json({ error: "not_suspended" });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { suspendedAt: null, suspendedReason: null } });
    await audit(tx, req.authUser!.id, req.ip, "user.unsuspend", "User", user.id, { email: user.email });
  });
  res.json({ id: user.id, suspended: false });
}));

/** For the web UI: whether this deployment has env-configured admins. */
platformAdminRouter.get("/me", (req, res) => {
  res.json({ email: req.authUser!.email, envAdmins: platformAdminEmails().size });
});
