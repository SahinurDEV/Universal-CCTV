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
    expect(res.body.connectionImplemented).toBe(false);
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
