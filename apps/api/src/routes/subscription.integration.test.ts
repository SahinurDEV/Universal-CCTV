import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";

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

describe("subscription plans and lifecycle", () => {
  it("lists the seeded plan catalog without authentication", async () => {
    const res = await request(app).get("/subscription/plans");
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: { key: string }) => p.key).sort()).toEqual(["free", "pro", "starter"]);
  });

  it("requires authentication to read a tenant's own subscription", async () => {
    const res = await request(app).get("/subscription");
    expect(res.status).toBe(401);
  });

  it("gives a new tenant a TRIALING subscription to the free plan automatically", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "sub-lifecycle-password-123", tenantName: "Sub Lifecycle Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const res = await agent.get("/subscription");
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe("TRIALING");
    expect(res.body.subscription.plan.key).toBe("free");
    expect(res.body.usage.cameraLimit).toBe(2);
  });

  it(
    "changing plans updates status/limits for real and never charges real money",
    async () => {
      const agent = request.agent(app);
      const reg = await agent
        .post("/auth/register")
        .send({ email: uniqueEmail(), password: "sub-change-password-123", tenantName: "Sub Change Tenant" });
      createdUserIds.push(reg.body.user.id);
      createdTenantIds.push(reg.body.tenant.id);

      const changeRes = await agent.post("/subscription/change").send({ planKey: "starter" });
      expect(changeRes.status).toBe(200);
      expect(changeRes.body.subscription.status).toBe("ACTIVE");
      expect(changeRes.body.subscription.billingProvider).toBe("dev");

      const afterChange = await agent.get("/subscription");
      expect(afterChange.body.subscription.plan.key).toBe("starter");
      expect(afterChange.body.usage.cameraLimit).toBe(10);

      const cancelRes = await agent.post("/subscription/cancel");
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.subscription.status).toBe("CANCELED");
    },
    15000,
  );

  it("rejects an unknown plan key", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "sub-invalid-password-123", tenantName: "Sub Invalid Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const res = await agent.post("/subscription/change").send({ planKey: "does-not-exist" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_plan");
  });
});

describe("quota enforcement", () => {
  it("blocks creating a camera past the free trial's 2-camera limit", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "camera-limit-password-123", tenantName: "Camera Limit Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const create = (name: string) =>
      agent.post("/cameras").send({ name, connectorType: "SIMULATED", host: "localhost", port: 8554 });

    const first = await create("Limit Cam 1");
    expect(first.status).toBe(201);
    const second = await create("Limit Cam 2");
    expect(second.status).toBe(201);

    const third = await create("Limit Cam 3");
    expect(third.status).toBe(402);
    expect(third.body.error).toBe("camera_limit_reached");
    expect(third.body.limit).toBe(2);
  });

  it("blocks assigning a retention policy longer than the plan allows", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "retention-limit-password-123", tenantName: "Retention Limit Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const createRes = await agent.post("/cameras").send({
      name: "Retention Limit Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
    });
    const cameraId = createRes.body.id;

    const policiesRes = await agent.get("/retention-policies");
    const thirtyDayPolicy = policiesRes.body.policies.find((p: { retentionDays: number }) => p.retentionDays === 30);

    // Free trial's maxRetentionDays is 7 — 30 exceeds it.
    const patchRes = await agent.patch(`/cameras/${cameraId}`).send({ retentionPolicyId: thirtyDayPolicy.id });
    expect(patchRes.status).toBe(402);
    expect(patchRes.body.error).toBe("retention_exceeds_plan");
    expect(patchRes.body.limit).toBe(7);

    // The 7-day policy itself (within the limit) must still be allowed.
    const sevenDayPolicy = policiesRes.body.policies.find((p: { retentionDays: number }) => p.retentionDays === 7);
    const okRes = await agent.patch(`/cameras/${cameraId}`).send({ retentionPolicyId: sevenDayPolicy.id });
    expect(okRes.status).toBe(200);
  });

  it("blocks starting a recording once storage usage is at or over the plan's quota", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "storage-limit-password-123", tenantName: "Storage Limit Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);
    const tenantId = reg.body.tenant.id;

    const createRes = await agent.post("/cameras").send({
      name: "Storage Limit Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    const cameraId = createRes.body.id;

    // Simulate the free plan's 5GB already being full — directly inserting
    // a segment row with that size is far faster than actually recording
    // 5GB of real video, and the enforcement logic only cares about the sum
    // of fileSizeBytes, which this exercises identically to a real segment.
    const job = await prisma.recordingJob.create({ data: { cameraId, tenantId, status: "STOPPED" } });
    await prisma.recordingSegment.create({
      data: {
        tenantId,
        cameraId,
        jobId: job.id,
        startedAt: new Date(),
        objectKey: `tenants/${tenantId}/cameras/${cameraId}/recordings/test/${randomUUID()}.mp4`,
        fileSizeBytes: 6n * 1024n * 1024n * 1024n, // 6 GiB > the free plan's 5 GB quota
        status: "COMPLETE",
      },
    });

    const startRes = await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    expect(startRes.status).toBe(402);
    expect(startRes.body.error).toBe("storage_quota_exceeded");
  });
});
