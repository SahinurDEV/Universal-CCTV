import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createSession, setActiveTenant, SESSION_COOKIE_NAME } from "../lib/sessions.js";
import { writeAuditLog } from "../lib/audit.js";
import { requireAuth } from "../middleware/auth.js";
import { authRateLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import { isPlatformAdminUser } from "../lib/platform-admin.js";
import { hasControlChars } from "../lib/validation.js";

export const authRouter = Router();

const TRIAL_PERIOD_DAYS = 14;

export function cookieOptions() {
  const env = loadEnv();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

// bcrypt only uses the first 72 bytes of a password, and very long inputs
// are a cheap CPU DoS against the hashing step, so cap the length.
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "Password is too long (max 72 bytes)");

// Emails are case-insensitive in practice; normalizing prevents duplicate
// accounts that differ only in case and makes login case-insensitive.
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// Used to keep login timing the same whether or not the email exists
// (otherwise "no such user" returns instantly and enumerates accounts).
const DUMMY_PASSWORD_HASH = "$2a$12$3scIcCEZQlVzYAct0uk3rO91T.PmR0.f0kmK4zuWsOUwIpHqSLr56";

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  tenantName: z.string().trim().min(1).max(200),
});

authRouter.post("/auth/register", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { email, password, tenantName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Same response shape/timing-insensitive message as "created" would be
    // ideal to avoid account enumeration, but for MVP we return a clear
    // error — acceptable tradeoff documented in docs/security.md.
    return res.status(409).json({ error: "email_already_registered" });
  }

  const passwordHash = await hashPassword(password);

  const { user, tenant } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, passwordHash } });
    const tenant = await tx.tenant.create({ data: { name: tenantName } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });

    // Example retention tiers per docs/requirements.md §9 — not fixed
    // product commitments, just starting options every new tenant gets so
    // there's always a sensible default (30 days) rather than leaving
    // retention policy undefined (undefined policy means "never auto-delete,"
    // not "delete immediately" — see recording/retention.ts).
    await tx.retentionPolicy.createMany({
      data: [
        { tenantId: tenant.id, name: "7 days", retentionDays: 7, isDefault: false },
        { tenantId: tenant.id, name: "30 days", retentionDays: 30, isDefault: true },
        { tenantId: tenant.id, name: "90 days", retentionDays: 90, isDefault: false },
      ],
    });

    // Every tenant starts on a trial of the free plan. If the free plan
    // hasn't been seeded (see prisma/seed.ts — a deployment prerequisite),
    // registration still succeeds but the tenant has no subscription; quota
    // checks (camera limit, storage quota) treat "no subscription" the same
    // as "unlimited" rather than blocking registration on a seeding bug —
    // see routes/subscription.ts.
    const freePlan = await tx.subscriptionPlan.findUnique({ where: { key: "free" } });
    if (freePlan) {
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: freePlan.id,
          status: "TRIALING",
          currentPeriodEnd: new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    } else {
      logger.warn({ tenantId: tenant.id }, "no 'free' subscription plan found — has prisma/seed.ts been run?");
    }

    return { user, tenant };
  });

  await writeAuditLog({
    tenantId: tenant.id,
    actorUserId: user.id,
    action: "user.register",
    targetType: "User",
    targetId: user.id,
  });

  const { rawToken } = await createSession(user.id, tenant.id);
  res.cookie(SESSION_COOKIE_NAME, rawToken, cookieOptions());
  res.status(201).json({
    user: { id: user.id, email: user.email, displayName: user.displayName },
    tenant: { id: tenant.id, name: tenant.name, role: "OWNER" },
  });
}));

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

authRouter.post("/auth/login", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { include: { tenant: true } } },
  });

  // Constant-shape response whether the user exists or not, so login can't
  // be used to enumerate registered emails via timing/response differences
  // beyond what bcrypt's own timing already reveals.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    logger.info({ event: "auth.login_failed" }, "failed login attempt");
    return res.status(401).json({ error: "invalid_credentials" });
  }
  // Only revealed after a correct password, so it can't enumerate accounts.
  if (user.suspendedAt) return res.status(403).json({ error: "account_suspended" });

  const firstMembership = user.memberships[0];
  const { rawToken } = await createSession(user.id, firstMembership?.tenantId ?? null);

  // AuditLog.tenantId is a required FK — a user with zero memberships has no
  // tenant to attach the record to, so there's nothing to write in that case.
  if (firstMembership) {
    await writeAuditLog({
      tenantId: firstMembership.tenantId,
      actorUserId: user.id,
      action: "user.login",
      targetType: "User",
      targetId: user.id,
    });
  }

  res.cookie(SESSION_COOKIE_NAME, rawToken, cookieOptions());
  res.json({
    user: { id: user.id, email: user.email, displayName: user.displayName },
    tenants: user.memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
    activeTenantId: firstMembership?.tenantId ?? null,
  });
}));

const mobileLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  deviceName: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !hasControlChars(v) && !/[<>]/.test(v), "invalid characters")
    .optional(),
});

/**
 * Native-app login. Same credential checks, rate limit and enumeration
 * resistance as /auth/login, but returns an opaque bearer token in the body
 * instead of setting a cookie (apps send `Authorization: Bearer <token>`).
 * The token is shown once; only its hash is stored. Revocable like any
 * session (logout, password change, "sign out other devices").
 */
authRouter.post("/auth/mobile/login", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = mobileLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { email, password, deviceName } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { include: { tenant: true } } },
  });
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    logger.info({ event: "auth.login_failed", client: "mobile" }, "failed login attempt");
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (user.suspendedAt) return res.status(403).json({ error: "account_suspended" });
  const firstMembership = user.memberships[0];
  const { rawToken, session } = await createSession(user.id, firstMembership?.tenantId ?? null, {
    clientType: "mobile",
    deviceName: deviceName || null,
  });
  if (firstMembership) {
    await writeAuditLog({
      tenantId: firstMembership.tenantId,
      actorUserId: user.id,
      action: "user.login",
      targetType: "User",
      targetId: user.id,
      metadata: { client: "mobile" },
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    token: rawToken,
    tokenType: "Bearer",
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email, displayName: user.displayName },
    tenants: user.memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
    activeTenantId: firstMembership?.tenantId ?? null,
  });
}));

authRouter.post("/auth/logout", requireAuth, asyncHandler(async (req, res) => {
  // Revoke exactly the session that authenticated this request (cookie or
  // bearer), and stop native pushes registered by it.
  await prisma.session.update({ where: { id: req.authSession!.id }, data: { revokedAt: new Date() } });
  await prisma.fcmToken.deleteMany({ where: { sessionId: req.authSession!.id } });
  const { maxAge: _maxAge, ...clearOpts } = cookieOptions();
  res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
  res.status(204).send();
}));

authRouter.get("/auth/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.authUser!.id },
    include: { memberships: { include: { tenant: true } } },
  });
  if (!user) {
    return res.status(401).json({ error: "unauthorized" });
  }

  res.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, isPlatformAdmin: isPlatformAdminUser(user) },
    tenants: user.memberships.map((m) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      role: m.role,
      suspended: m.tenant.suspendedAt != null,
    })),
    activeTenantId: req.authSession!.activeTenantId,
  });
}));

const switchTenantSchema = z.object({ tenantId: z.string().uuid() });

authRouter.post("/auth/switch-tenant", requireAuth, asyncHandler(async (req, res) => {
  const parsed = switchTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: parsed.data.tenantId, userId: req.authUser!.id } },
  });
  if (!membership) {
    return res.status(403).json({ error: "forbidden" });
  }

  await setActiveTenant(req.authSession!.id, parsed.data.tenantId);
  res.status(204).send();
}));
