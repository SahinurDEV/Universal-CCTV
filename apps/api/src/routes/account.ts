import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { writeAuditLog } from "../lib/audit.js";
import { sensitiveActionRateLimiter } from "../middleware/rateLimit.js";
import { NOTIFICATION_TYPES, mutedTypesFrom } from "../lib/notification-prefs.js";
import { passwordSchema } from "./auth.js";
import { hasControlChars } from "../lib/validation.js";

/** The signed-in user's own account: profile, password, sessions, and
 * per-workspace alert preferences. Never touches other users. */
export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.get("/", asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.authUser!.id },
    include: { memberships: { include: { tenant: true } } },
  });
  if (!user) return res.status(401).json({ error: "unauthorized" });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      passwordChangedAt: user.passwordChangedAt,
    },
    memberships: user.memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenant.name, role: m.role })),
  });
}));

const profileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !hasControlChars(v) && !/[<>]/.test(v), "must not contain control characters or angle brackets")
    .nullable(),
});

accountRouter.patch("/profile", asyncHandler(async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const user = await prisma.user.update({
    where: { id: req.authUser!.id },
    data: { displayName: parsed.data.displayName || null },
  });
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
}));

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

/**
 * Changes the password after verifying the current one, then revokes every
 * OTHER session for this user (a stolen session on another device stops
 * working immediately). The current session stays signed in.
 */
accountRouter.post("/password", sensitiveActionRateLimiter, asyncHandler(async (req, res) => {
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const user = await prisma.user.findUnique({ where: { id: req.authUser!.id } });
  if (!user) return res.status(401).json({ error: "unauthorized" });

  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return res.status(400).json({ error: "invalid_current_password" });
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return res.status(400).json({ error: "password_unchanged" });
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  const now = new Date();
  const [, revoked] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now } }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: req.authSession!.id } },
      data: { revokedAt: now },
    }),
  ]);

  const tenantId = req.authSession!.activeTenantId;
  if (tenantId) {
    await writeAuditLog({
      tenantId,
      actorUserId: user.id,
      action: "user.password_change",
      targetType: "User",
      targetId: user.id,
      metadata: { otherSessionsRevoked: revoked.count },
    });
  }
  res.json({ ok: true, otherSessionsRevoked: revoked.count });
}));

accountRouter.get("/sessions", asyncHandler(async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.authUser!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, clientType: true, deviceName: true },
  });
  res.json({
    sessions: sessions.map((s) => ({ ...s, current: s.id === req.authSession!.id })),
  });
}));

/** "Sign out everywhere else". */
accountRouter.post("/sessions/revoke-others", sensitiveActionRateLimiter, asyncHandler(async (req, res) => {
  const result = await prisma.session.updateMany({
    where: { userId: req.authUser!.id, revokedAt: null, id: { not: req.authSession!.id } },
    data: { revokedAt: new Date() },
  });
  res.json({ revoked: result.count });
}));

const prefsSchema = z.object({
  mutedTypes: z.array(z.enum(NOTIFICATION_TYPES as [string, ...string[]])).max(NOTIFICATION_TYPES.length),
});

accountRouter.get("/notification-preferences", requireTenant, asyncHandler(async (req, res) => {
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: req.authTenant!.id, userId: req.authUser!.id } },
  });
  res.json({ types: NOTIFICATION_TYPES, mutedTypes: mutedTypesFrom(membership?.notificationPreferences) });
}));

accountRouter.put("/notification-preferences", requireTenant, asyncHandler(async (req, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const mutedTypes = [...new Set(parsed.data.mutedTypes)];
  await prisma.membership.update({
    where: { tenantId_userId: { tenantId: req.authTenant!.id, userId: req.authUser!.id } },
    data: { notificationPreferences: { mutedTypes } },
  });
  res.json({ types: NOTIFICATION_TYPES, mutedTypes });
}));
