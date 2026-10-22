import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

const sent: { endpoint: string; payload: string }[] = [];
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      if (sub.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload });
      return { statusCode: 201 };
    },
  },
}));

// This sandbox's DNS maps public names to a 198.18/15 proxy range, which the
// SSRF guard (correctly) blocks. Resolve the push host as a public IP here;
// literal-IP and scheme checks still run for real.
vi.mock("../lib/network-guard.js", async (orig) => {
  const real = await orig<typeof import("../lib/network-guard.js")>();
  return {
    ...real,
    assertSafeResolvedCameraHost: async (host: string) => {
      real.assertSafeCameraHost(host);
      if (host === "fcm.googleapis.com") return;
      return real.assertSafeResolvedCameraHost(host);
    },
  };
});

process.env.VAPID_PUBLIC_KEY ||= "BD3KIuUBuoPXr3Cps9x75TtIg-MMYCRA5TRhRfFQNMqIwxj5SEVuwj2LONxrtIM871GqJ2UzsTybiBHIpM6kinM";
process.env.VAPID_PRIVATE_KEY ||= "nPjHJbS2qMUQVtWZt_pIyAXmPVv8XmD7H6VFfQ6b4GU";

const { createApp } = await import("../app.js");
const { prisma } = await import("../lib/db.js");
const { dispatchNotificationToPush } = await import("../lib/push.js");

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const a = request.agent(app);
const b = request.agent(app);
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const ep = (tag: string) => `https://fcm.googleapis.com/fcm/send/${tag}-${randomUUID()}`;

beforeAll(async () => {
  for (const agent of [a, b]) {
    const res = await agent.post("/auth/register").send({ email: `push-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: "Push Co" });
    userIds.push(res.body.user.id);
    tenantIds.push(res.body.tenant.id);
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("web push subscriptions", () => {
  let subId = "";
  it("exposes the public key, never the private key", async () => {
    const res = await a.get("/push/config");
    expect(res.body.enabled).toBe(true);
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
    expect(JSON.stringify(res.body)).not.toContain(process.env.VAPID_PRIVATE_KEY!);
    expect((await request(app).get("/push/config")).status).toBe(401);
  });

  it("subscribes a device and lists it without the full endpoint", async () => {
    const endpoint = ep("dev1");
    const res = await a.post("/push/subscriptions").send({ endpoint, keys: KEYS, userAgent: "Test Phone" });
    expect(res.status).toBe(201);
    subId = res.body.id;
    const list = await a.get("/push/subscriptions");
    expect(list.body.subscriptions).toHaveLength(1);
    expect(list.body.subscriptions[0]).toMatchObject({ service: "fcm.googleapis.com", userAgent: "Test Phone" });
    expect(JSON.stringify(list.body)).not.toContain(endpoint);
    expect((await b.get("/push/subscriptions")).body.subscriptions).toHaveLength(0);
  });

  it("rejects unsafe or malformed endpoints (SSRF)", async () => {
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "https://localhost/x", "not a url"]) {
      const res = await a.post("/push/subscriptions").send({ endpoint, keys: KEYS });
      expect(res.status, endpoint).toBe(400);
    }
    expect((await a.post("/push/subscriptions").send({ endpoint: ep("bad"), keys: { p256dh: "<script>", auth: "x" } })).status).toBe(400);
  });

  it("users can't delete other users' devices", async () => {
    expect((await b.delete(`/push/subscriptions/${subId}`)).status).toBe(404);
  });

  it("dispatch follows alert preferences and prunes gone subscriptions", async () => {
    const tenantId = tenantIds[0]!;
    const gone = await prisma.pushSubscription.create({ data: { userId: userIds[0]!, endpoint: ep("gone"), ...KEYS } });
    sent.length = 0;
    const n = await prisma.notification.create({ data: { tenantId, type: "PERSON_DETECTED", targetId: randomUUID(), message: "Person detected on \"Gate\"." } });
    expect(await dispatchNotificationToPush(n)).toBe(1);
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({ title: "Person detected", body: n.message });
    expect(await prisma.pushSubscription.findUnique({ where: { id: gone.id } })).toBeNull();

    await a.put("/account/notification-preferences").send({ mutedTypes: ["PERSON_DETECTED"] });
    sent.length = 0;
    expect(await dispatchNotificationToPush(n)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("test push and removal", async () => {
    sent.length = 0;
    const res = await a.post("/push/test");
    expect(res.body).toMatchObject({ devices: 1, sent: 1 });
    expect((await a.delete(`/push/subscriptions/${subId}`)).status).toBe(204);
    expect((await a.get("/push/subscriptions")).body.subscriptions).toHaveLength(0);
  });
});
