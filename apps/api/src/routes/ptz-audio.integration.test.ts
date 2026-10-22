import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { startOnvifSimulator, type OnvifSimulator } from "../onvif-sim/server.js";
import { startBackchannelSimulator, type BackchannelSim } from "../onvif-sim/rtsp-backchannel-sim.js";
import { clearBackchannelCache } from "./ptz.js";
import { forgetPtzSession } from "../connectors/onvif-ptz.js";

/**
 * End-to-end PTZ + talk tests against local simulators (no real camera):
 *  - ONVIF device/media/PTZ SOAP simulator (src/onvif-sim/server.ts)
 *  - RTSP server with an ONVIF backchannel (src/onvif-sim/rtsp-backchannel-sim.ts)
 *  - MediaMTX's fake camera for the RTSP video probe.
 * Simulators bind to the box's private LAN address, because the SSRF guard
 * (correctly) refuses loopback for real ONVIF cameras.
 */
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const other = request.agent(app);
let ownerTenant = "";
let ownerUser = "";
let ptzCam = "";
let fixedCam = "";
let talkCam = "";
let simCam = "";
let onvif: OnvifSimulator;
let fixedOnvif: OnvifSimulator;
let rtsp: BackchannelSim;

async function register(agent: ReturnType<typeof request.agent>, name: string) {
  const res = await agent
    .post("/auth/register")
    .send({ email: `ptz-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: name });
  expect(res.status).toBe(201);
  userIds.push(res.body.user.id);
  tenantIds.push(res.body.tenant.id);
  return res.body;
}

async function setRole(role: "OWNER" | "VIEWER") {
  await prisma.membership.update({ where: { tenantId_userId: { tenantId: ownerTenant, userId: ownerUser } }, data: { role } });
}

beforeAll(async () => {
  expect(lanIp, "need a non-loopback IPv4 address").toBeTruthy();
  onvif = await startOnvifSimulator({ host: lanIp, username: "admin", password: "sim-pass" });
  fixedOnvif = await startOnvifSimulator({ host: lanIp, username: "admin", password: "sim-pass", ptz: false });
  rtsp = await startBackchannelSimulator({ host: lanIp, username: "admin", password: "sim-pass" });
  const o = await register(owner, "PTZ Owner Co");
  ownerTenant = o.tenant.id;
  ownerUser = o.user.id;
  await register(other, "PTZ Other Co");
  expect((await owner.post("/subscription/change").send({ planKey: "starter" })).status).toBe(200);

  const add = async (name: string, port: number, onvifPort: number | undefined, path: string) => {
    const res = await owner.post("/cameras").send({
      name, connectorType: "ONVIF", host: lanIp, port, onvifPort,
      credential: { username: "admin", password: "sim-pass", path },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  ptzCam = await add("PTZ Cam", 8554, onvif.port, "simulated");
  fixedCam = await add("Fixed Cam", 8554, fixedOnvif.port, "simulated");
  talkCam = await add("Talk Cam", rtsp.port, undefined, "stream");
  const sim = await owner.post("/cameras").send({ name: "Sim", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  simCam = sim.body.id;
}, 30000);

afterAll(async () => {
  await Promise.all([onvif?.close(), fixedOnvif?.close(), rtsp?.close()]);
  [ptzCam, fixedCam].forEach(forgetPtzSession);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("PTZ capability detection via the real test-connection flow", () => {
  it("marks the simulated PTZ camera ptz=true and the fixed one ptz=false", async () => {
    const a = await owner.post(`/cameras/${ptzCam}/test-connection`);
    expect(a.status).toBe(200);
    const b = await owner.post(`/cameras/${fixedCam}/test-connection`);
    expect(b.status).toBe(200);
    const capA = await prisma.cameraCapabilityRecord.findUniqueOrThrow({ where: { cameraId: ptzCam } });
    const capB = await prisma.cameraCapabilityRecord.findUniqueOrThrow({ where: { cameraId: fixedCam } });
    expect(capA.ptz).toBe(true);
    expect(capA.liveView).toBe(true);
    expect(capB.ptz).toBe(false);
  }, 40000);
});

describe("PTZ API", () => {
  it("reports support only for PTZ cameras", async () => {
    const yes = await owner.get(`/cameras/${ptzCam}/ptz`);
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ supported: true, canControl: true, presets: [] });
    const no = await owner.get(`/cameras/${fixedCam}/ptz`);
    expect(no.body.supported).toBe(false);
    expect((await owner.post(`/cameras/${fixedCam}/ptz/move`).send({ x: 0.5 })).status).toBe(409);
  });

  it("moves, stops, and the simulator position changes", async () => {
    const before = { ...onvif.state.position };
    const mv = await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 1, y: -0.5, zoom: 0.5, timeoutMs: 2000 });
    expect(mv.status).toBe(200);
    expect(onvif.state.moving).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const st = await owner.post(`/cameras/${ptzCam}/ptz/stop`);
    expect(st.status).toBe(200);
    expect(onvif.state.moving).toBe(false);
    expect(onvif.state.position.x).toBeGreaterThan(before.x);
    expect(onvif.state.position.y).toBeLessThan(before.y);
    expect(onvif.state.position.zoom).toBeGreaterThan(before.zoom);
    const s = await owner.get(`/cameras/${ptzCam}/ptz`);
    expect(s.body.status.position.x).toBeCloseTo(onvif.state.position.x, 3);
  });

  it("validates move input strictly", async () => {
    expect((await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 2 })).status).toBe(400);
    expect((await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 0.1, timeoutMs: 60000 })).status).toBe(400);
    expect((await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 0.1, evil: 1 })).status).toBe(400);
  });

  it("sets, lists, goes to and removes presets", async () => {
    const set = await owner.post(`/cameras/${ptzCam}/ptz/presets`).send({ name: "Front door" });
    expect(set.status).toBe(201);
    const token = set.body.token as string;
    expect(token).toBeTruthy();
    const saved = { ...onvif.state.position };
    await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: -1, timeoutMs: 500 });
    await new Promise((r) => setTimeout(r, 200));
    await owner.post(`/cameras/${ptzCam}/ptz/stop`);
    const list = await owner.get(`/cameras/${ptzCam}/ptz`);
    expect(list.body.presets).toEqual([{ token, name: "Front door" }]);
    expect((await owner.post(`/cameras/${ptzCam}/ptz/presets/${token}/goto`)).status).toBe(200);
    expect(onvif.state.position.x).toBeCloseTo(saved.x, 5);
    expect((await owner.post(`/cameras/${ptzCam}/ptz/presets`).send({ name: "<script>" })).status).toBe(400);
    expect((await owner.post(`/cameras/${ptzCam}/ptz/presets/bad%20token/goto`)).status).toBe(400);
    expect((await owner.delete(`/cameras/${ptzCam}/ptz/presets/${token}`)).status).toBe(204);
    expect((await owner.get(`/cameras/${ptzCam}/ptz`)).body.presets).toEqual([]);
  });

  it("audit-logs PTZ use", async () => {
    const logs = await prisma.auditLog.findMany({ where: { tenantId: ownerTenant, targetId: ptzCam, action: { startsWith: "camera.ptz." } } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ["camera.ptz.move", "camera.ptz.stop", "camera.ptz.preset.set", "camera.ptz.preset.goto", "camera.ptz.preset.remove"]) {
      expect(actions.has(a)).toBe(true);
    }
    expect(logs.every((l) => l.actorUserId === ownerUser)).toBe(true);
  });

  it("forbids viewers from controlling PTZ but lets them see support", async () => {
    await setRole("VIEWER");
    try {
      const g = await owner.get(`/cameras/${ptzCam}/ptz`);
      expect(g.status).toBe(200);
      expect(g.body.canControl).toBe(false);
      expect((await owner.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 0.2 })).status).toBe(403);
      expect((await owner.post(`/cameras/${ptzCam}/ptz/stop`)).status).toBe(403);
      expect((await owner.post(`/cameras/${ptzCam}/ptz/presets`).send({ name: "x" })).status).toBe(403);
      expect((await owner.post(`/cameras/${talkCam}/audio/talk`).set("Content-Type", "audio/webm").send(Buffer.from("x"))).status).toBe(403);
    } finally {
      await setRole("OWNER");
    }
  });

  it("hides other workspaces' cameras", async () => {
    expect((await other.get(`/cameras/${ptzCam}/ptz`)).status).toBe(404);
    expect((await other.post(`/cameras/${ptzCam}/ptz/move`).send({ x: 0.1 })).status).toBe(404);
    expect((await other.get(`/cameras/${talkCam}/audio`)).status).toBe(404);
  });

  it("rate-limits PTZ commands per user", async () => {
    let limited = false;
    for (let i = 0; i < 260 && !limited; i++) {
      const r = await owner.post(`/cameras/${fixedCam}/ptz/stop`);
      if (r.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  }, 60000);
});

describe("two-way audio (ONVIF backchannel)", () => {
  it("reports talk support from a real RTSP DESCRIBE with the backchannel Require header", async () => {
    clearBackchannelCache();
    const t = await owner.get(`/cameras/${talkCam}/audio`);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ talk: true, codec: "PCMU", canTalk: true });
    // MediaMTX (our fake camera relay) has no backchannel: honest "no".
    const n = await owner.get(`/cameras/${ptzCam}/audio`);
    expect(n.body).toMatchObject({ talk: false, reason: "no_backchannel" });
    const s = await owner.get(`/cameras/${simCam}/audio`);
    expect(s.body).toMatchObject({ talk: false, reason: "simulated_camera" });
  });

  it("transcodes a browser-style webm/opus clip and streams G.711 RTP to the camera", async () => {
    const clip = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
    const before = rtsp.receivedPackets;
    const r = await owner.post(`/cameras/${talkCam}/audio/talk`).set("Content-Type", "audio/webm").send(clip);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, codec: "PCMU" });
    expect(r.body.seconds).toBeCloseTo(1, 0);
    expect(rtsp.receivedPackets - before).toBeGreaterThanOrEqual(45);
    expect([...rtsp.payloadTypes]).toEqual([0]);
    const log = await prisma.auditLog.findFirst({ where: { targetId: talkCam, action: "camera.audio.talk" } });
    expect(log).not.toBeNull();
  }, 20000);

  it("rejects talk where unsupported or with garbage audio", async () => {
    expect((await owner.post(`/cameras/${ptzCam}/audio/talk`).set("Content-Type", "audio/webm").send(Buffer.from("abc"))).status).toBe(409);
    expect((await owner.post(`/cameras/${simCam}/audio/talk`).set("Content-Type", "audio/webm").send(Buffer.from("abc"))).status).toBe(409);
    expect((await owner.post(`/cameras/${talkCam}/audio/talk`).set("Content-Type", "audio/webm").send(Buffer.from("not audio"))).status).toBe(400);
    expect((await owner.post(`/cameras/${talkCam}/audio/talk`).set("Content-Type", "audio/webm")).status).toBe(400);
  });
});
