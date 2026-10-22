import { describe, expect, it } from "vitest";
import { loadEnv } from "../env.js";
import { isPlatformAdminUser, platformAdminEmails } from "./platform-admin.js";

describe("platform admin role", () => {
  it("DB flag or env list, case-insensitive; workspace roles irrelevant", () => {
    const env = loadEnv();
    const prev = env.PLATFORM_ADMIN_EMAILS;
    env.PLATFORM_ADMIN_EMAILS = " Ops@Example.com, ,second@example.com";
    try {
      expect([...platformAdminEmails()]).toEqual(["ops@example.com", "second@example.com"]);
      expect(isPlatformAdminUser({ email: "OPS@example.com", isPlatformAdmin: false })).toBe(true);
      expect(isPlatformAdminUser({ email: "owner@example.com", isPlatformAdmin: false })).toBe(false);
      expect(isPlatformAdminUser({ email: "owner@example.com", isPlatformAdmin: true })).toBe(true);
    } finally {
      env.PLATFORM_ADMIN_EMAILS = prev;
    }
    env.PLATFORM_ADMIN_EMAILS = undefined;
    expect(platformAdminEmails().size).toBe(0);
    env.PLATFORM_ADMIN_EMAILS = prev;
  });
});
