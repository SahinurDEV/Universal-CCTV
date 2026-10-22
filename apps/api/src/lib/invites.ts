import { createHash, randomBytes } from "node:crypto";
import type { Role } from "@prisma/client";

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Roles a member with `actorRole` may hand out (invite or assign).
 * OWNER: any role. ADMIN: anything below OWNER. Others: none. */
export function assignableRoles(actorRole: Role): Role[] {
  if (actorRole === "OWNER") return ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];
  if (actorRole === "ADMIN") return ["ADMIN", "OPERATOR", "VIEWER"];
  return [];
}

/** Whether `actorRole` may change or remove a member whose role is `targetRole`. */
export function canManageMember(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return targetRole !== "OWNER";
  return false;
}

export type InviteState = "pending" | "accepted" | "revoked" | "expired";

export function inviteState(inv: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): InviteState {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}
