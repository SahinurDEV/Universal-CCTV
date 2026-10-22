import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";
import { findValidSession, SESSION_COOKIE_NAME } from "../lib/sessions.js";
import { prisma } from "../lib/db.js";
import { asyncHandler } from "./async-handler.js";
import { isPlatformAdminUser } from "../lib/platform-admin.js";

const BEARER_RE = /^Bearer ([0-9a-f]{64})$/;

/** Where the session token came from. Mobile apps send
 * `Authorization: Bearer <token>` (no cookies → not CSRF-able); browsers use
 * the httpOnly cookie. A token is only accepted through the channel its
 * session was issued for, so a web cookie can't be replayed as a bearer
 * token or vice versa. A malformed Authorization header is rejected rather
 * than silently falling back to the cookie. */
export function extractSessionToken(req: Request): { token: string; channel: "web" | "mobile" } | null | "invalid" {
  const header = req.headers.authorization;
  if (header !== undefined) {
    const m = BEARER_RE.exec(header);
    return m ? { token: m[1]!, channel: "mobile" } : "invalid";
  }
  const cookie = req.cookies?.[SESSION_COOKIE_NAME];
  return typeof cookie === "string" && cookie ? { token: cookie, channel: "web" } : null;
}

export const requireAuth = asyncHandler(async (req, res, next) => {
  const extracted = extractSessionToken(req);
  if (!extracted || extracted === "invalid") {
    return res.status(401).json({ error: "unauthorized" });
  }

  const session = await findValidSession(extracted.token);
  if (!session || session.clientType !== extracted.channel) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (session.user.suspendedAt) {
    return res.status(403).json({ error: "account_suspended" });
  }

  req.authUser = { id: session.user.id, email: session.user.email };
  req.authSession = { id: session.id, activeTenantId: session.activeTenantId, clientType: extracted.channel };
  next();
});

/** Must run after requireAuth. Requires the session to have an active tenant
 * the user is actually a member of, and attaches the membership's role. */
export const requireTenant = asyncHandler(async (req, res, next) => {
  if (!req.authUser || !req.authSession) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const tenantId = req.authSession.activeTenantId;
  if (!tenantId) {
    return res.status(400).json({ error: "no_active_tenant" });
  }

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId: req.authUser.id } },
    include: { tenant: { select: { suspendedAt: true } } },
  });

  if (!membership) {
    // Session points at a tenant the user is no longer (or never was) a
    // member of — treat as forbidden, not a server error.
    return res.status(403).json({ error: "forbidden" });
  }

  if (membership.tenant.suspendedAt) {
    return res.status(403).json({ error: "tenant_suspended" });
  }

  req.authTenant = { id: tenantId, role: membership.role };
  next();
});

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authTenant || !roles.includes(req.authTenant.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}

/** Must run after requireAuth. Platform super-admin only — independent of
 * any workspace role (a workspace OWNER is NOT a platform admin). Browser
 * (cookie) sessions only, so a leaked mobile bearer token can never reach
 * the admin API. */
export const requirePlatformAdmin = asyncHandler(async (req, res, next) => {
  if (!req.authUser || !req.authSession) return res.status(401).json({ error: "unauthorized" });
  if (req.authSession.clientType !== "web") return res.status(403).json({ error: "forbidden" });
  const user = await prisma.user.findUnique({
    where: { id: req.authUser.id },
    select: { email: true, isPlatformAdmin: true, suspendedAt: true },
  });
  if (!user || user.suspendedAt || !isPlatformAdminUser(user)) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
});
