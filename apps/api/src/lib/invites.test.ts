import { describe, expect, it } from "vitest";
import { assignableRoles, canManageMember, generateInviteToken, hashInviteToken, inviteState } from "./invites.js";

describe("invite tokens", () => {
  it("are long, unique and hashed deterministically", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashInviteToken(a)).toBe(hashInviteToken(a));
    expect(hashInviteToken(a)).not.toContain(a);
  });
});

describe("role rules", () => {
  it("only owners can hand out OWNER", () => {
    expect(assignableRoles("OWNER")).toContain("OWNER");
    expect(assignableRoles("ADMIN")).not.toContain("OWNER");
    expect(assignableRoles("OPERATOR")).toEqual([]);
    expect(assignableRoles("VIEWER")).toEqual([]);
  });
  it("admins cannot manage owners", () => {
    expect(canManageMember("ADMIN", "OWNER")).toBe(false);
    expect(canManageMember("ADMIN", "VIEWER")).toBe(true);
    expect(canManageMember("OWNER", "OWNER")).toBe(true);
    expect(canManageMember("OPERATOR", "VIEWER")).toBe(false);
  });
});

describe("inviteState", () => {
  const future = new Date(Date.now() + 60_000);
  it("derives state", () => {
    expect(inviteState({ acceptedAt: null, revokedAt: null, expiresAt: future })).toBe("pending");
    expect(inviteState({ acceptedAt: new Date(), revokedAt: null, expiresAt: future })).toBe("accepted");
    expect(inviteState({ acceptedAt: null, revokedAt: new Date(), expiresAt: future })).toBe("revoked");
    expect(inviteState({ acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() - 1) })).toBe("expired");
  });
});
