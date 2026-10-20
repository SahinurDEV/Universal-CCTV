import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";

const app = createApp();
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

function uniqueEmail() {
  return `test-${randomUUID()}@example.com`;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("camera CRUD and tenant isolation", () => {
  let tenantAId: string;
  let tenantBId: string;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  let cameraId: string;

  beforeAll(async () => {
    agentA = request.agent(app);
    const regA = await agentA
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "tenant-a-password-123", tenantName: "Tenant A" });
    tenantAId = regA.body.tenant.id;
    createdUserIds.push(regA.body.user.id);
    createdTenantIds.push(regA.body.tenant.id);

    agentB = request.agent(app);
    const regB = await agentB
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "tenant-b-password-123", tenantName: "Tenant B" });
    tenantBId = regB.body.tenant.id;
    createdUserIds.push(regB.body.user.id);
    createdTenantIds.push(regB.body.tenant.id);

    // A second user in Tenant A with the VIEWER role, added directly via
    // Prisma since there's no "invite member" endpoint yet — RBAC on camera
    // creation should still block them.
    const viewerEmail = uniqueEmail();
    const viewerPassword = "viewer-password-123";
    const viewerUser = await prisma.user.create({
      data: { email: viewerEmail, passwordHash: await hashPassword(viewerPassword) },
    });
    await prisma.membership.create({
      data: { tenantId: tenantAId, userId: viewerUser.id, role: "VIEWER" },
    });
    createdUserIds.push(viewerUser.id);

    viewerAgent = request.agent(app);
    await viewerAgent.post("/auth/login").send({ email: viewerEmail, password: viewerPassword });
  });

  it("creates a camera with an honest, unconfirmed capability record", async () => {
    const res = await agentA.post("/cameras").send({
      name: "Front Door",
      connectorType: "RTSP",
      host: "192.168.1.50",
      port: 554,
      credential: { username: "admin", password: "camera-secret", path: "/stream1" },
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Front Door");
    expect(res.body.hasCredential).toBe(true);
    expect(res.body.capability.supportTier).toBe("UNSUPPORTED");
    expect(res.body.capability.liveView).toBe(false);
    expect(res.body.connectionImplemented).toBe(true);
    // The plaintext credential must never come back in the API response.
    expect(res.body.credential).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("camera-secret");

    cameraId = res.body.id;
  });

  it("rejects a loopback host (SSRF-lite guard)", async () => {
    const res = await agentA.post("/cameras").send({
      name: "Bad Camera",
      connectorType: "RTSP",
      host: "127.0.0.1",
      port: 554,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsafe_host");
  });

  it("rejects the cloud metadata address (SSRF-lite guard)", async () => {
    const res = await agentA.post("/cameras").send({
      name: "Metadata Probe",
      connectorType: "RTSP",
      host: "169.254.169.254",
      port: 80,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsafe_host");
  });

  it("rejects an arbitrary host declared as SIMULATED — a prior real bug let this bypass the guard entirely", async () => {
    const res = await agentA.post("/cameras").send({
      name: "Fake Simulated Camera",
      connectorType: "SIMULATED",
      host: "169.254.169.254",
      port: 80,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsafe_host");
  });

  it("still allows a real SIMULATED camera pinned to the dev fixture host", async () => {
    const res = await agentA.post("/cameras").send({
      name: "Real Simulated Camera For Guard Test",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
    });
    expect(res.status).toBe(201);
  });

  it("lists only the creating tenant's cameras", async () => {
    const resA = await agentA.get("/cameras");
    expect(resA.status).toBe(200);
    expect(resA.body.cameras.some((c: { id: string }) => c.id === cameraId)).toBe(true);

    const resB = await agentB.get("/cameras");
    expect(resB.status).toBe(200);
    expect(resB.body.cameras.some((c: { id: string }) => c.id === cameraId)).toBe(false);
  });

  it("blocks cross-tenant read/update/delete with 404, not 403 (no existence leak)", async () => {
    const getRes = await agentB.get(`/cameras/${cameraId}`);
    expect(getRes.status).toBe(404);

    const patchRes = await agentB.patch(`/cameras/${cameraId}`).send({ name: "Hijacked" });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentB.delete(`/cameras/${cameraId}`);
    expect(deleteRes.status).toBe(404);

    // Confirm tenant A's camera is untouched by tenant B's attempts.
    const stillThere = await agentA.get(`/cameras/${cameraId}`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.name).toBe("Front Door");
  });

  it("allows the owner to update the camera", async () => {
    const res = await agentA.patch(`/cameras/${cameraId}`).send({ name: "Front Door (renamed)" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Front Door (renamed)");
  });

  it("VIEWER role can read but not create cameras (RBAC)", async () => {
    const listRes = await viewerAgent.get("/cameras");
    expect(listRes.status).toBe(200);

    const createRes = await viewerAgent.post("/cameras").send({
      name: "Viewer Should Not Be Able To Create This",
      connectorType: "RTSP",
      host: "192.168.1.51",
      port: 554,
    });
    expect(createRes.status).toBe(403);
  });

  it("deletes the camera, after which it 404s for its own tenant too", async () => {
    const deleteRes = await agentA.delete(`/cameras/${cameraId}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await agentA.get(`/cameras/${cameraId}`);
    expect(getRes.status).toBe(404);
  });
});

describe("POST /cameras/:id/test-connection", () => {
  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;

  beforeAll(async () => {
    agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "test-connection-password-123", tenantName: "Test Connection Co" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);
    tenantId = reg.body.tenant.id;
  });

  it("confirms capabilities for real against the live simulated RTSP stream", async () => {
    // docker-compose's mediamtx + simulated-camera services publish a real,
    // continuously-live test-pattern stream (h264 video + aac audio) over
    // RTSP — this hits that for real, not a mock. Requires
    // `docker compose up` (see docs/testing.md).
    const createRes = await agent.post("/cameras").send({
      name: "Simulated Test Camera",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    expect(createRes.status).toBe(201);
    const cameraId = createRes.body.id;

    const testRes = await agent.post(`/cameras/${cameraId}/test-connection`);
    expect(testRes.status).toBe(200);
    expect(testRes.body.ok).toBe(true);
    expect(testRes.body.supportTier).toBe("FULLY_SUPPORTED");
    expect(testRes.body.capability.liveView).toBe(true);
    expect(testRes.body.capability.cloudRecording).toBe(true);
    expect(testRes.body.capability.audio).toBe(true);
    expect(testRes.body.streams.some((s: { codecType: string }) => s.codecType === "video")).toBe(true);

    // The capability record on the camera itself should now reflect the
    // confirmed result, not the "nothing confirmed yet" default from create.
    const detail = await agent.get(`/cameras/${cameraId}`);
    expect(detail.body.capability.supportTier).toBe("FULLY_SUPPORTED");
    expect(detail.body.capability.liveView).toBe(true);
  }, 20000);

  it("reports a real, honest failure for a camera that doesn't actually stream", async () => {
    const createRes = await agent.post("/cameras").send({
      name: "Nonexistent Path Camera",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/this-path-does-not-exist" },
    });
    const cameraId = createRes.body.id;

    const testRes = await agent.post(`/cameras/${cameraId}/test-connection`);
    expect(testRes.status).toBe(200);
    expect(testRes.body.ok).toBe(false);
    expect(testRes.body.supportTier).toBe("UNSUPPORTED");
    expect(testRes.body.capability.liveView).toBe(false);
    expect(testRes.body.error.reason).toBe("connection_failed");
    // The error message must never leak the RTSP URL.
    expect(testRes.body.error.message).not.toContain("rtsp://");
  }, 20000);

  it("404s for another tenant's camera, not 403", async () => {
    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-tenant-password-123", tenantName: "Other Tenant Co" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);

    const createRes = await agent.post("/cameras").send({
      name: "Isolation Check Camera",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    const cameraId = createRes.body.id;

    const testRes = await otherAgent.post(`/cameras/${cameraId}/test-connection`);
    expect(testRes.status).toBe(404);
  });

  it(
    "for an ONVIF camera, attempts real ONVIF capability confirmation and falls back honestly when the device isn't actually ONVIF",
    async () => {
      // Created directly via Prisma, not POST /cameras: the create route's
      // SSRF guard blocks "localhost" for every connector type except
      // SIMULATED by design (see docs/security.md), and that guard already
      // has its own dedicated test coverage — this test exists to exercise
      // the test-connection route's ONVIF-capability wiring itself, which
      // is a separate concern from the create-time host guard.
      const camera = await prisma.camera.create({
        data: {
          tenantId,
          name: "ONVIF Wiring Check Camera",
          connectorType: "ONVIF",
          host: "localhost",
          port: 8554, // the real simulated RTSP stream — this should succeed
          onvifPort: 9997, // MediaMTX's real config API — a real server, just not an ONVIF one
        },
      });
      await prisma.cameraCapabilityRecord.create({
        data: { cameraId: camera.id, supportTier: "UNSUPPORTED" },
      });
      // The RTSP probe needs the real stream's path, same as every other
      // SIMULATED-fixture test — without this, buildRtspUrl has no path and
      // the RTSP probe itself fails, which would mask what this test is
      // actually checking (the ONVIF capability fallback, not RTSP).
      const { encryptSecret } = await import("../lib/crypto.js");
      const encrypted = encryptSecret(JSON.stringify({ path: "/simulated" }));
      await prisma.cameraCredential.create({
        data: { cameraId: camera.id, encryptedValue: encrypted.ciphertext, encryptionIv: encrypted.iv },
      });

      const testRes = await agent.post(`/cameras/${camera.id}/test-connection`);
      expect(testRes.status).toBe(200);
      // RTSP succeeded for real.
      expect(testRes.body.ok).toBe(true);
      expect(testRes.body.capability.liveView).toBe(true);
      // The real ONVIF probe was attempted and failed cleanly (wrong
      // protocol), so this must NOT be FULLY_SUPPORTED — no ONVIF-only
      // capability may be claimed from a device that never confirmed it.
      expect(testRes.body.supportTier).toBe("CONNECTED_MISSING_CAPABILITIES");
      expect(testRes.body.capability.ptz).toBe(false);
      expect(testRes.body.capability.zoom).toBe(false);
      expect(testRes.body.capability.motionEvents).toBe(false);
      expect(testRes.body.capability.imageSettings).toBe(false);
      expect(testRes.body.capability.firmwareUpdate).toBe(false);
    },
    20000,
  );
});

describe("POST /cameras/discover", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/cameras/discover").send({});
    expect(res.status).toBe(401);
  });

  it("runs a real WS-Discovery probe and returns a well-formed result", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "discover-password-123", tenantName: "Discover Test Co" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    // Short timeout since this test environment has no real ONVIF camera to
    // find — the point is confirming the probe runs and resolves cleanly
    // (not that it finds anything), per docs/camera-integration.md's
    // documented LAN-only limitation.
    const res = await agent.post("/cameras/discover").send({ timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.devices)).toBe(true);
    expect(typeof res.body.note).toBe("string");
  }, 10000);
});
