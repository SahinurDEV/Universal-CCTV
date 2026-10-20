import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createSession, findValidSession, revokeSession, setActiveTenant, SESSION_COOKIE_NAME } from "../lib/sessions.js";
import { writeAuditLog } from "../lib/audit.js";
import { requireAuth } from "../middleware/auth.js";
import { authRateLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";

export const authRouter = Router();

const TRIAL_PERIOD_DAYS = 14;

function cookieOptions() {
  const env = loadEnv();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  tenantName: z.string().min(1).max(200),
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
    user: { id: user.id, email: user.email },
    tenant: { id: tenant.id, name: tenant.name, role: "OWNER" },
  });
}));

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
  const passwordMatches = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

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
    user: { id: user.id, email: user.email },
    tenants: user.memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
    activeTenantId: firstMembership?.tenantId ?? null,
  });
}));

authRouter.post("/auth/logout", requireAuth, asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (rawToken) {
    await revokeSession(rawToken);
  }
  res.clearCookie(SESSION_COOKIE_NAME);
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
    user: { id: user.id, email: user.email },
    tenants: user.memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
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
