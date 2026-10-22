import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { hashLinkToken } from "../lib/share-tokens.js";
import { removePathIfExists } from "../connectors/mediamtx-client.js";

const app = createApp();
const anon = () => request(app);
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const other = request.agent(app);
let tenantId = "";
let userId = "";
let cameraId = "";
let otherCameraId = "";
let segA = "";

async function register(agent: ReturnType<typeof request.agent>, name: string) {
  const res = await agent.post("/auth/register").send({ email: `share-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: name });
  expect(res.status).toBe(201);
  userIds.push(res.body.user.id);
  tenantIds.push(res.body.tenant.id);
  return res.body;
}

const tokenOf = (url: string) => url.split("/share/")[1]!;

beforeAll(async () => {
  const o = await register(owner, "Share Owner Co");
  tenantId = o.tenant.id;
  userId = o.user.id;
  await register(other, "Share Other Co");
  const cam = await owner.post("/cameras").send({ name: "Share Cam", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  cameraId = cam.body.id;
  const cam2 = await owner.post("/cameras").send({ name: "Private Cam", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  otherCameraId = cam2.body.id;
  // Recorded segments: two in range on the shared camera, one outside, one on another camera.
  const base = Date.now() - 2 * 60 * 60 * 1000;
  for (const cid of [cameraId, otherCameraId]) {
    const job = await prisma.recordingJob.create({ data: { cameraId: cid, tenantId, status: "STOPPED" } });
    for (const [i, offMin] of [[0, 0], [1, 1], [2, 30]] as const) {
      const s = await prisma.recordingSegment.create({
        data: { tenantId, cameraId: cid, jobId: job.id, startedAt: new Date(base + offMin * 60_000), endedAt: new Date(base + offMin * 60_000 + 60_000), durationSec: 60, objectKey: `test/share/${cid}/${i}-${randomUUID()}.mp4`, status: "COMPLETE" },
      });
      if (cid === cameraId && i === 0) segA = s.id;
    }
  }
  void segA;
});

afterAll(async () => {
  await removePathIfExists(cameraId).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("share links", () => {
  it("validates input", async () => {
    const bad = [
      { kind: "LIVE", expiresInMinutes: 1 },
      { kind: "LIVE", expiresInMinutes: 60 * 24 * 8 },
      { kind: "CLIP", expiresInMinutes: 60 },
      { kind: "CLIP", expiresInMinutes: 60, clipStart: new Date(Date.now() - 1000).toISOString(), clipEnd: new Date(Date.now() - 2000).toISOString() },
      { kind: "CLIP", expiresInMinutes: 60, clipStart: new Date(Date.now() - 3 * 3600e3).toISOString(), clipEnd: new Date(Date.now() - 1000).toISOString() },
      { kind: "LIVE", expiresInMinutes: 60, password: "123" },
      { kind: "LIVE", expiresInMinutes: 60, extra: true },
    ];
    for (const b of bad) expect((await owner.post(`/cameras/${cameraId}/shares`).send(b)).status).toBe(400);
    expect((await other.post(`/cameras/${cameraId}/shares`).send({ kind: "LIVE", expiresInMinutes: 60 })).status).toBe(404);
  });

  it("stores only a hash of the token and never lists tokens", async () => {
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "LIVE", expiresInMinutes: 60, label: "For the plumber" });
    expect(r.status).toBe(201);
    const token = tokenOf(r.body.url);
    expect(token).toBe(r.body.token);
    const row = await prisma.shareLink.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.tokenHash).toBe(hashLinkToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await owner.get("/shares");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.links[0]).toMatchObject({ id: r.body.id, status: "active", label: "For the plumber", cameraName: "Share Cam" });
    expect((await other.get("/shares")).body.links).toEqual([]);
    const audit = await prisma.auditLog.findFirst({ where: { targetId: r.body.id, action: "share.create" } });
    expect(audit?.actorUserId).toBe(userId);
  });

  it("serves live HLS publicly for the shared camera only", async () => {
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "LIVE", expiresInMinutes: 30 });
    const open = await anon().post(`/public/share/${r.body.token}/open`).send({});
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ kind: "LIVE", cameraName: "Share Cam" });
    expect(open.headers["cache-control"]).toBe("no-store");
    let playlist = await anon().get(open.body.playlistUrl);
    for (let i = 0; i < 20 && playlist.status !== 200; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      playlist = await anon().get(open.body.playlistUrl);
    }
    expect(playlist.status).toBe(200);
    expect(playlist.text).toContain("#EXTM3U");
    // The view token can't be used for clips or other files.
    expect((await anon().get(`/public/share/v/${open.body.viewToken}/clip`)).status).toBe(404);
    expect((await anon().get(`/public/share/v/${open.body.viewToken}/hls/..%2F..%2Fx.m3u8`)).status).toBe(404);
    expect((await anon().get(`/public/share/v/garbage/hls/index.m3u8`)).status).toBe(404);
    // Authenticated camera API stays closed to the public.
    expect((await anon().get(`/cameras/${otherCameraId}/live/hls/index.m3u8`)).status).toBe(401);
  }, 40000);

  it("serves a clip with only in-range segments of that camera", async () => {
    const seg = await prisma.recordingSegment.findUniqueOrThrow({ where: { id: segA } });
    const clipStart = new Date(seg.startedAt.getTime() + 30_000);
    const clipEnd = new Date(seg.startedAt.getTime() + 90_000);
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "CLIP", expiresInMinutes: 60, clipStart, clipEnd });
    expect(r.status).toBe(201);
    const open = await anon().post(`/public/share/${r.body.token}/open`).send({});
    expect(open.status).toBe(200);
    const clip = await anon().get(open.body.clipUrl);
    expect(clip.status).toBe(200);
    expect(clip.body.segments).toHaveLength(2);
    expect(clip.body.segments[0].offsetSec).toBeCloseTo(30, 0);
    expect(clip.body.segments.every((s: { url: string }) => s.url.includes(`/test/share/${cameraId}/`))).toBe(true);
    expect((await anon().get(`/public/share/v/${open.body.viewToken}/hls/index.m3u8`)).status).toBe(404);
  });

  it("enforces password, view limit, revocation and expiry", async () => {
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "CLIP", expiresInMinutes: 60, clipStart: new Date(Date.now() - 3600e3), clipEnd: new Date(Date.now() - 3000e3), password: "letmein1", maxViews: 2 });
    const t = r.body.token;
    expect((await anon().post(`/public/share/${t}/open`).send({})).body.error).toBe("password_required");
    expect((await anon().post(`/public/share/${t}/open`).send({ password: "nope-nope" })).status).toBe(401);
    expect((await anon().post(`/public/share/${t}/open`).send({ password: "letmein1" })).status).toBe(200);
    const v2 = await anon().post(`/public/share/${t}/open`).send({ password: "letmein1" });
    expect(v2.status).toBe(200);
    expect((await anon().post(`/public/share/${t}/open`).send({ password: "letmein1" })).status).toBe(404);
    expect((await prisma.shareLink.findUniqueOrThrow({ where: { id: r.body.id } })).viewCount).toBe(2);
    expect(await prisma.auditLog.count({ where: { targetId: r.body.id, action: "share.password_failed" } })).toBe(1);

    const live = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "CLIP", expiresInMinutes: 60, clipStart: new Date(Date.now() - 3600e3), clipEnd: new Date(Date.now() - 3000e3) });
    const opened = await anon().post(`/public/share/${live.body.token}/open`).send({});
    expect((await anon().get(opened.body.clipUrl)).status).toBe(200);
    expect((await owner.delete(`/shares/${live.body.id}`)).status).toBe(204);
    // Revocation kills already-issued view tokens immediately.
    expect((await anon().get(opened.body.clipUrl)).status).toBe(404);
    expect((await anon().post(`/public/share/${live.body.token}/open`).send({})).status).toBe(404);
    expect((await other.delete(`/shares/${live.body.id}`)).status).toBe(404);

    await prisma.shareLink.update({ where: { id: r.body.id }, data: { expiresAt: new Date(Date.now() - 1000), maxViews: null } });
    expect((await anon().post(`/public/share/${t}/open`).send({ password: "letmein1" })).status).toBe(404);
    const list = await owner.get("/shares");
    const statuses = Object.fromEntries(list.body.links.map((l: { id: string; status: string }) => [l.id, l.status]));
    expect(statuses[r.body.id]).toBe("expired");
    expect(statuses[live.body.id]).toBe("revoked");
  });

  it("rejects forged and unknown tokens identically", async () => {
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "LIVE", expiresInMinutes: 30 });
    const forged = r.body.token.slice(0, -2) + (r.body.token.endsWith("AA") ? "BB" : "AA");
    const a = await anon().post(`/public/share/${forged}/open`).send({});
    const b = await anon().post(`/public/share/not-a-token/open`).send({});
    expect(a.status).toBe(404);
    expect(b.body).toEqual(a.body);
  });

  it("blocks links of a suspended workspace, including already-open viewers", async () => {
    const r = await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "CLIP", expiresInMinutes: 60, clipStart: new Date(Date.now() - 3600e3), clipEnd: new Date(Date.now() - 3000e3) });
    const opened = await anon().post(`/public/share/${r.body.token}/open`).send({});
    expect(opened.status).toBe(200);
    await prisma.tenant.update({ where: { id: tenantId }, data: { suspendedAt: new Date(), suspendedReason: "test" } });
    try {
      expect((await anon().get(opened.body.clipUrl)).status).toBe(404);
      expect((await anon().post(`/public/share/${r.body.token}/open`).send({})).status).toBe(404);
    } finally {
      await prisma.tenant.update({ where: { id: tenantId }, data: { suspendedAt: null, suspendedReason: null } });
    }
  });

  it("forbids viewers from creating or listing links", async () => {
    await prisma.membership.update({ where: { tenantId_userId: { tenantId, userId } }, data: { role: "VIEWER" } });
    try {
      expect((await owner.post(`/cameras/${cameraId}/shares`).send({ kind: "LIVE", expiresInMinutes: 30 })).status).toBe(403);
      expect((await owner.get("/shares")).status).toBe(403);
    } finally {
      await prisma.membership.update({ where: { tenantId_userId: { tenantId, userId } }, data: { role: "OWNER" } });
    }
  });

  it("rate-limits opening links per IP", async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      if ((await anon().post(`/public/share/not-a-token/open`).send({})).status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
