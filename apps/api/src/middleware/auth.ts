import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";
import { findValidSession, SESSION_COOKIE_NAME } from "../lib/sessions.js";
import { prisma } from "../lib/db.js";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawToken) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const session = await findValidSession(rawToken);
  if (!session) {
    return res.status(401).json({ error: "unauthorized" });
  }

  req.authUser = { id: session.user.id, email: session.user.email };
  req.authSession = { id: session.id, activeTenantId: session.activeTenantId };
  next();
}

/** Must run after requireAuth. Requires the session to have an active tenant
 * the user is actually a member of, and attaches the membership's role. */
export async function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser || !req.authSession) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const tenantId = req.authSession.activeTenantId;
  if (!tenantId) {
    return res.status(400).json({ error: "no_active_tenant" });
  }

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId: req.authUser.id } },
  });

  if (!membership) {
    // Session points at a tenant the user is no longer (or never was) a
    // member of — treat as forbidden, not a server error.
    return res.status(403).json({ error: "forbidden" });
  }

  req.authTenant = { id: tenantId, role: membership.role };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authTenant || !roles.includes(req.authTenant.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}
