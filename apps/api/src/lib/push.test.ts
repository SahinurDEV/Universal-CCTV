import { describe, expect, it } from "vitest";

// Empty (not deleted) so a later dotenv load can't re-populate them.
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

describe("push without VAPID keys", () => {
  it("is disabled and dispatch is a no-op (fails safe)", async () => {
    const { dispatchNotificationToPush, isPushConfigured } = await import("./push.js");
    expect(isPushConfigured()).toBe(false);
    await expect(
      dispatchNotificationToPush({ id: "x", tenantId: "t", type: "MOTION_DETECTED", message: "m", targetId: null }),
    ).resolves.toBe(0);
  });
});
