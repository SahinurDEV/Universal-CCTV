import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { notifyOnce } from "../lib/notifications.js";
import { signPayload } from "../lib/webhooks.js";

const app = createApp();
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function registerAgent(tenantName: string) {
  const agent = request.agent(app);
  const email = `test-${randomUUID()}@example.com`;
  const password = "platform-test-password-1";
  const res = await agent.post("/auth/register").send({ email, password, tenantName });
  expect(res.status).toBe(201);
  createdUserIds.push(res.body.user.id);
  createdTenantIds.push(res.body.tenant.id);
  return { agent, email, password, tenantId: res.body.tenant.id as string, userId: res.body.user.id as string };
}

let a: Awaited<ReturnType<typeof registerAgent>>;
let b: Awaited<ReturnType<typeof registerAgent>>;
let viewer: ReturnType<typeof request.agent>;

beforeAll(async () => {
  a = await registerAgent("Platform Tenant A");
  b = await registerAgent("Platform Tenant B");

  // VIEWER member of tenant A (no invite endpoint yet — created directly).
  const { hashPassword } = await import("../lib/password.js");
  const viewerEmail = `viewer-${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email: viewerEmail, passwordHash: await hashPassword("viewer-password-123") },
  });
  createdUserIds.push(user.id);
  await prisma.membership.create({ data: { tenantId: a.tenantId, userId: user.id, role: "VIEWER" } });
  viewer = request.agent(app);
  const login = await viewer.post("/auth/login").send({ email: viewerEmail, password: "viewer-password-123" });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("locations", () => {
  let locationId: string;

  it("creates, lists, updates a location (tenant-scoped)", async () => {
    const created = await a.agent
      .post("/locations")
      .send({ name: "Head office", address: "12 Main Road", timezone: "Asia/Dhaka" });
    expect(created.status).toBe(201);
    expect(created.body.cameraCount).toBe(0);
    locationId = created.body.id;

    const list = await a.agent.get("/locations");
    expect(list.body.locations.map((l: { id: string }) => l.id)).toContain(locationId);

    const otherList = await b.agent.get("/locations");
    expect(otherList.body.locations.map((l: { id: string }) => l.id)).not.toContain(locationId);

    const updated = await a.agent.patch(`/locations/${locationId}`).send({ name: "HQ" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("HQ");
  });

  it("validates input", async () => {
    expect((await a.agent.post("/locations").send({ name: "" })).status).toBe(400);
    expect((await a.agent.post("/locations").send({ name: "X", timezone: "Mars/Olympus" })).status).toBe(400);
  });

  it("assigns cameras and rejects another tenant's camera ids", async () => {
    const cam = await a.agent.post("/cameras").send({
      name: "Lobby",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    expect(cam.status).toBe(201);
    const bCam = await b.agent.post("/cameras").send({
      name: "B cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
    });

    const bad = await a.agent.post(`/locations/${locationId}/cameras`).send({ cameraIds: [cam.body.id, bCam.body.id] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_camera");

    const ok = await a.agent.post(`/locations/${locationId}/cameras`).send({ cameraIds: [cam.body.id] });
    expect(ok.status).toBe(200);
    const detail = await a.agent.get(`/locations/${locationId}`);
    expect(detail.body.cameraCount).toBe(1);
    expect(detail.body.cameras[0].id).toBe(cam.body.id);
  });

  it("hides other tenants' locations (404) and blocks VIEWER writes (403)", async () => {
    expect((await b.agent.get(`/locations/${locationId}`)).status).toBe(404);
    expect((await b.agent.patch(`/locations/${locationId}`).send({ name: "pwned" })).status).toBe(404);
    expect((await b.agent.delete(`/locations/${locationId}`)).status).toBe(404);
    expect((await viewer.get(`/locations/${locationId}`)).status).toBe(200);
    expect((await viewer.post("/locations").send({ name: "nope" })).status).toBe(403);
    expect((await viewer.delete(`/locations/${locationId}`)).status).toBe(403);
  });

  it("deleting a location keeps its cameras (unassigned)", async () => {
    const del = await a.agent.delete(`/locations/${locationId}`);
    expect(del.status).toBe(204);
    const cams = await a.agent.get("/cameras");
    const lobby = cams.body.cameras.find((c: { name: string }) => c.name === "Lobby");
    expect(lobby).toBeTruthy();
    expect(lobby.locationId).toBeNull();
  });
});

describe("account settings", () => {
  it("updates the display name", async () => {
    const res = await a.agent.patch("/account/profile").send({ displayName: "Rahim" });
    expect(res.status).toBe(200);
    expect((await a.agent.get("/account")).body.user.displayName).toBe("Rahim");
    expect((await a.agent.patch("/account/profile").send({ displayName: "<script>" })).status).toBe(400);
  });

  it("changes password: requires the current one, revokes other sessions, keeps this one", async () => {
    const second = request.agent(app);
    expect((await second.post("/auth/login").send({ email: a.email, password: a.password })).status).toBe(200);

    const wrong = await a.agent.post("/account/password").send({ currentPassword: "nope-nope-nope", newPassword: "new-password-456" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_current_password");

    const short = await a.agent.post("/account/password").send({ currentPassword: a.password, newPassword: "short" });
    expect(short.status).toBe(400);

    const ok = await a.agent.post("/account/password").send({ currentPassword: a.password, newPassword: "new-password-456" });
    expect(ok.status).toBe(200);
    expect(ok.body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);

    expect((await a.agent.get("/auth/me")).status).toBe(200);
    expect((await second.get("/auth/me")).status).toBe(401);

    const oldLogin = await request(app).post("/auth/login").send({ email: a.email, password: a.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post("/auth/login").send({ email: a.email.toUpperCase(), password: "new-password-456" });
    expect(newLogin.status).toBe(200);
    a.password = "new-password-456";
  });

  it("lists sessions with the current one flagged", async () => {
    const res = await a.agent.get("/account/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions.some((s: { current: boolean }) => s.current)).toBe(true);
  });

  it("notification preferences hide muted alert types for that member only", async () => {
    await notifyOnce({ tenantId: a.tenantId, type: "CAMERA_OFFLINE", targetId: randomUUID(), message: "offline!", cooldownMinutes: 1 });
    await notifyOnce({ tenantId: a.tenantId, type: "UPLOAD_FAILURE", targetId: randomUUID(), message: "upload!", cooldownMinutes: 1 });

    const put = await a.agent.put("/account/notification-preferences").send({ mutedTypes: ["CAMERA_OFFLINE"] });
    expect(put.status).toBe(200);
    expect((await a.agent.get("/account/notification-preferences")).body.mutedTypes).toEqual(["CAMERA_OFFLINE"]);

    const mine = await a.agent.get("/notifications");
    expect(mine.body.notifications.map((n: { type: string }) => n.type)).not.toContain("CAMERA_OFFLINE");
    expect(mine.body.notifications.map((n: { type: string }) => n.type)).toContain("UPLOAD_FAILURE");

    const viewerList = await viewer.get("/notifications");
    expect(viewerList.body.notifications.map((n: { type: string }) => n.type)).toContain("CAMERA_OFFLINE");

    expect((await a.agent.put("/account/notification-preferences").send({ mutedTypes: ["NOT_A_TYPE"] })).status).toBe(400);
  });
});

describe("integrations (webhooks)", () => {
  it("rejects SSRF-style webhook URLs", async () => {
    for (const url of [
      "http://localhost:4100/x",
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://user:pass@example.com/x",
      "ftp://example.com/x",
      "not a url",
    ]) {
      const res = await a.agent.post("/integrations").send({ provider: "webhook", name: "x", url });
      expect(res.status, url).toBe(400);
    }
  });

  it("VIEWER cannot create integrations; other tenants can't see or touch them", async () => {
    expect(
      (await viewer.post("/integrations").send({ provider: "webhook", name: "x", url: "https://example.com/hook" })).status,
    ).toBe(403);
  });

  // Delivery needs a receiver on a NON-loopback address (loopback is blocked
  // by design). Uses this machine's first private LAN IPv4, if it has one.
  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  it.skipIf(!lanIp)("creates a webhook, shows the secret once, delivers signed alerts, and is tenant-isolated", async () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, lanIp, () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const created = await a.agent.post("/integrations").send({
        provider: "webhook",
        name: "My receiver",
        url: `http://${lanIp}:${port}/hook`,
        events: ["STORAGE_QUOTA_WARNING"],
      });
      expect(created.status).toBe(201);
      const secret: string = created.body.signingSecret;
      expect(secret).toMatch(/^whsec_/);

      const list = await a.agent.get("/integrations");
      expect(JSON.stringify(list.body)).not.toContain(secret);
      expect(list.body.integrations).toHaveLength(1);
      expect((await b.agent.get("/integrations")).body.integrations).toHaveLength(0);
      expect((await b.agent.post(`/integrations/${created.body.id}/test`)).status).toBe(404);
      expect((await b.agent.delete(`/integrations/${created.body.id}`)).status).toBe(404);

      const test = await a.agent.post(`/integrations/${created.body.id}/test`);
      expect(test.status).toBe(200);
      expect(test.body.ok).toBe(true);
      expect(received).toHaveLength(1);
      const first = received[0]!;
      const ts = String(first.headers["x-cctv-timestamp"]);
      expect(first.headers["x-cctv-signature"]).toBe(`sha256=${signPayload(secret, ts, first.body)}`);

      // Subscribed type is delivered, unsubscribed type is not.
      await notifyOnce({ tenantId: a.tenantId, type: "STORAGE_QUOTA_WARNING", targetId: null, message: "80% full", cooldownMinutes: 1 });
      await notifyOnce({ tenantId: a.tenantId, type: "RECORDING_STOPPED", targetId: randomUUID(), message: "stopped", cooldownMinutes: 1 });
      await new Promise((r) => setTimeout(r, 1000));
      const alerts = received.slice(1).map((r) => JSON.parse(r.body));
      expect(alerts).toHaveLength(1);
      expect(alerts[0].alert.type).toBe("STORAGE_QUOTA_WARNING");

      const del = await a.agent.delete(`/integrations/${created.body.id}`);
      expect(del.status).toBe(204);
    } finally {
      server.close();
    }
  });
});

describe("live view (real MediaMTX HLS through the authenticated proxy)", () => {
  let cameraId: string;

  beforeAll(async () => {
    const cam = await a.agent.post("/cameras").send({
      name: "Live Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    expect(cam.status).toBe(201);
    cameraId = cam.body.id;
  });

  it("requires auth and tenant ownership", async () => {
    expect((await request(app).post(`/cameras/${cameraId}/live/start`)).status).toBe(401);
    expect((await request(app).get(`/cameras/${cameraId}/live/hls/index.m3u8`)).status).toBe(401);
    expect((await b.agent.post(`/cameras/${cameraId}/live/start`)).status).toBe(404);
    expect((await b.agent.get(`/cameras/${cameraId}/live/hls/index.m3u8`)).status).toBe(404);
  });

  it("rejects path traversal / odd file names", async () => {
    for (const f of ["..%2F..%2Fv3%2Fconfig%2Fglobal%2Fget", "index.m3u8%3Fx", "a.exe", "%2e%2e"]) {
      const res = await a.agent.get(`/cameras/${cameraId}/live/hls/${f}`);
      expect(res.status, f).toBe(404);
    }
  });

  it(
    "starts the stream and serves a real playlist + video segment to a VIEWER of the same tenant",
    async () => {
      const start = await viewer.post(`/cameras/${cameraId}/live/start`);
      expect(start.status).toBe(200);
      expect(start.body.playlistUrl).toBe(`/cameras/${cameraId}/live/hls/index.m3u8`);

      let playlist = "";
      for (let i = 0; i < 30; i++) {
        const res = await viewer.get(start.body.playlistUrl).buffer(true).parse((r, cb) => {
          let d = "";
          r.on("data", (c: Buffer) => (d += c.toString()));
          r.on("end", () => cb(null, d));
        });
        if (res.status === 200) {
          playlist = res.body as string;
          if (playlist.includes("#EXTINF") || playlist.includes(".m3u8")) break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(playlist).toContain("#EXTM3U");

      // Multivariant playlist -> media playlist -> first segment.
      let media = playlist;
      const childName = playlist.split("\n").find((l) => !l.startsWith("#") && l.includes(".m3u8"));
      if (childName) {
        for (let i = 0; i < 20; i++) {
          const res = await viewer.get(`/cameras/${cameraId}/live/hls/${childName.trim()}`).buffer(true).parse((r, cb) => {
            let d = "";
            r.on("data", (c: Buffer) => (d += c.toString()));
            r.on("end", () => cb(null, d));
          });
          media = res.body as string;
          if (res.status === 200 && media.includes("#EXTINF")) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      const segment = media.split("\n").find((l) => l.trim() && !l.startsWith("#"));
      expect(segment).toBeTruthy();
      const seg = await viewer.get(`/cameras/${cameraId}/live/hls/${segment!.trim()}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(seg.status).toBe(200);
      expect((seg.body as Buffer).length).toBeGreaterThan(1000);
      expect(seg.headers["cache-control"]).toBe("no-store");
    },
    60000,
  );
});

describe("CSRF origin check", () => {
  it("rejects state-changing requests from a foreign Origin, allows the configured web origin", async () => {
    const evil = await a.agent.post("/notifications/read-all").set("Origin", "http://evil.example");
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe("forbidden_origin");
    const allowedOrigin = (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",")[0]!;
    const ok = await a.agent.post("/notifications/read-all").set("Origin", allowedOrigin);
    expect(ok.status).toBe(204);
  });
});
