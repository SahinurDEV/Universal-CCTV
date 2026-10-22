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
    "refuses to dial a non-simulated camera whose stored host is loopback (connect-time SSRF check)",
    async () => {
      // Regression test for a real gap: the create-time guard blocks
      // "localhost", but a row that already holds a loopback host (inserted
      // before the guard existed, or via a DNS name that resolves to
      // 127.0.0.1) used to be dialed by test-connection anyway. The
      // connect-time check (network-guard.ts assertSafeResolvedCameraHost)
      // now re-validates right before ffprobe/ONVIF connect. This test
      // previously used exactly that gap to reach the local fixture as an
      // "ONVIF" camera; ONVIF fallback logic is covered by
      // onvif-capabilities.test.ts / .integration.test.ts instead.
      const camera = await prisma.camera.create({
        data: {
          tenantId,
          name: "Loopback ONVIF Camera",
          connectorType: "ONVIF",
          host: "localhost",
          port: 8554,
          onvifPort: 9997,
        },
      });
      await prisma.cameraCapabilityRecord.create({
        data: { cameraId: camera.id, supportTier: "UNSUPPORTED" },
      });

      const testRes = await agent.post(`/cameras/${camera.id}/test-connection`);
      expect(testRes.status).toBe(400);
      expect(testRes.body.error).toBe("unsafe_host");

      const startRes = await agent.post(`/cameras/${camera.id}/recording/start`).send({ segmentSeconds: 10 });
      expect(startRes.status).toBe(400);
      expect(startRes.body.error).toBe("unsafe_host");

      const liveRes = await agent.post(`/cameras/${camera.id}/live/start`);
      expect(liveRes.status).toBe(400);
      expect(liveRes.body.error).toBe("unsafe_host");
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
