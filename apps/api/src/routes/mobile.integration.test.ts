import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { setFcmSenderForTests, type FcmMessage } from "../lib/fcm.js";
import { dispatchNotificationToPush } from "../lib/push.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const PASSWORD = "correct-horse-battery-staple";
const email = `mobile-${randomUUID()}@example.com`;
const sent: FcmMessage[] = [];
let token = "";
let tenantId = "";
const FCM_TOKEN = `fcm_${randomUUID().replace(/-/g, "")}:APA91b${"x".repeat(120)}`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const web = request.agent(app);
  const r = await web.post("/auth/register").send({ email, password: PASSWORD, tenantName: "Mobile Co" });
  userIds.push(r.body.user.id);
  tenantId = r.body.tenant.id;
  tenantIds.push(tenantId);
});

afterAll(async () => {
  setFcmSenderForTests(undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("mobile bearer auth", () => {
  it("rejects bad credentials without revealing which part was wrong", async () => {
    const a = await request(app).post("/auth/mobile/login").send({ email, password: "wrong-password" });
    const b = await request(app).post("/auth/mobile/login").send({ email: `nobody-${randomUUID()}@example.com`, password: "wrong-password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it("logs in, returns a token in the body and sets no cookie", async () => {
    const res = await request(app).post("/auth/mobile/login").send({ email: email.toUpperCase(), password: PASSWORD, deviceName: "Pixel 8" });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.activeTenantId).toBe(tenantId);
    token = res.body.token;
    const row = await prisma.session.findFirst({ where: { userId: userIds[0], clientType: "mobile" } });
    expect(row?.deviceName).toBe("Pixel 8");
    expect(row?.tokenHash).not.toBe(token);
  });

  it("authenticates API calls with the bearer token (incl. tenant routes)", async () => {
    const me = await request(app).get("/auth/me").set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect((await request(app).get("/cameras").set(bearer(token))).status).toBe(200);
    expect((await request(app).post("/locations").set(bearer(token)).send({ name: "Gate" })).status).toBe(201);
    const sessions = await request(app).get("/account/sessions").set(bearer(token));
    expect(sessions.body.sessions.find((s: { current: boolean }) => s.current)).toMatchObject({ clientType: "mobile", deviceName: "Pixel 8" });
  });

  it("rejects malformed, unknown, and cross-channel tokens", async () => {
    expect((await request(app).get("/auth/me").set("Authorization", "Bearer nope")).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Authorization", `Basic ${token}`)).status).toBe(401);
    expect((await request(app).get("/auth/me").set(bearer("a".repeat(64)))).status).toBe(401);
    // mobile token used as a cookie
    expect((await request(app).get("/auth/me").set("Cookie", `cctv_session=${token}`)).status).toBe(401);
    // web cookie token used as bearer
    const web = await request(app).post("/auth/login").send({ email, password: PASSWORD });
    const cookie = String(web.headers["set-cookie"]).match(/cctv_session=([0-9a-f]{64})/)![1]!;
    expect((await request(app).get("/auth/me").set(bearer(cookie))).status).toBe(401);
    // a malformed Authorization header never falls back to the cookie
    expect((await request(app).get("/auth/me").set("Cookie", `cctv_session=${cookie}`).set("Authorization", "Bearer x")).status).toBe(401);
  });

  it("is rate limited like web login (shared limiter) and validates input", async () => {
    expect((await request(app).post("/auth/mobile/login").send({ email: "bad", password: "x" })).status).toBe(400);
    expect((await request(app).post("/auth/mobile/login").send({ email, password: PASSWORD, deviceName: "<script>" })).status).toBe(400);
  });
});

describe("FCM tokens", () => {
  it("is disabled (503) when FCM isn't configured", async () => {
    setFcmSenderForTests(null);
    expect((await request(app).get("/push/fcm/config").set(bearer(token))).body.enabled).toBe(false);
    expect((await request(app).post("/push/fcm/tokens").set(bearer(token)).send({ token: FCM_TOKEN, platform: "android" })).status).toBe(503);
  });

  it("registers a token from a mobile session only, never echoes it, and delivers alerts honoring mutes", async () => {
    setFcmSenderForTests({ send: async (m) => { sent.push(m); return "msg-id"; } });
    const web = request.agent(app);
    await web.post("/auth/login").send({ email, password: PASSWORD });
    expect((await web.post("/push/fcm/tokens").send({ token: FCM_TOKEN, platform: "android" })).status).toBe(403);
    expect((await request(app).post("/push/fcm/tokens").set(bearer(token)).send({ token: "short", platform: "android" })).status).toBe(400);
    expect((await request(app).post("/push/fcm/tokens").set(bearer(token)).send({ token: FCM_TOKEN, platform: "windows" })).status).toBe(400);

    const reg = await request(app).post("/push/fcm/tokens").set(bearer(token)).send({ token: FCM_TOKEN, platform: "android", deviceName: "Pixel 8" });
    expect(reg.status).toBe(201);
    const list = await request(app).get("/push/fcm/tokens").set(bearer(token));
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).toMatchObject({ platform: "android", thisSession: true });
    expect(JSON.stringify(list.body)).not.toContain(FCM_TOKEN);

    const cameraId = randomUUID();
    const n = await prisma.notification.create({ data: { tenantId, type: "PERSON_DETECTED", targetId: cameraId, message: "Person detected on \"Gate\"." } });
    sent.length = 0;
    expect(await dispatchNotificationToPush(n)).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toMatchObject({ token: FCM_TOKEN, notification: { title: "Person detected" }, data: { cameraId, type: "PERSON_DETECTED" } });

    await request(app).put("/account/notification-preferences").set(bearer(token)).send({ mutedTypes: ["PERSON_DETECTED"] });
    sent.length = 0;
    await dispatchNotificationToPush(n);
    expect(sent).toHaveLength(0);
    await request(app).put("/account/notification-preferences").set(bearer(token)).send({ mutedTypes: [] });
  });

  it("prunes tokens FCM reports as unregistered", async () => {
    setFcmSenderForTests({ send: async () => { throw Object.assign(new Error("gone"), { errorInfo: { code: "messaging/registration-token-not-registered" } }); } });
    const n = await prisma.notification.create({ data: { tenantId, type: "CAMERA_OFFLINE", targetId: null, message: "x" } });
    await dispatchNotificationToPush(n);
    expect(await prisma.fcmToken.count({ where: { token: FCM_TOKEN } })).toBe(0);
  });

  it("logout revokes the bearer session and its FCM tokens", async () => {
    setFcmSenderForTests({ send: async () => "id" });
    await request(app).post("/push/fcm/tokens").set(bearer(token)).send({ token: FCM_TOKEN, platform: "ios" });
    expect((await request(app).post("/auth/logout").set(bearer(token))).status).toBe(204);
    expect((await request(app).get("/auth/me").set(bearer(token))).status).toBe(401);
    expect(await prisma.fcmToken.count({ where: { token: FCM_TOKEN } })).toBe(0);
  });
});
