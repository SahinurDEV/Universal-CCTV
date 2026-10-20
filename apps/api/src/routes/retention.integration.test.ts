import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { enforceRetention } from "../recording/retention.js";

const app = createApp();
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

function uniqueEmail() {
  return `test-${randomUUID()}@example.com`;
}

async function s3ObjectExists(key: string): Promise<boolean> {
  const env = loadEnv();
  const client = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY },
  });
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("retention policies", () => {
  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;

  beforeAll(async () => {
    agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "retention-test-password-123", tenantName: "Retention Policy Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);
    tenantId = reg.body.tenant.id;

    // This describe block creates multiple cameras under one tenant across
    // several tests — upgrade past the free trial's 2-camera limit so this
    // stays decoupled from quota enforcement, which has its own dedicated test.
    await agent.post("/subscription/change").send({ planKey: "pro" });
  });

  it("creates three default policies on registration, 30-day marked default", async () => {
    const res = await agent.get("/retention-policies");
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(3);
    expect(res.body.policies.map((p: { retentionDays: number }) => p.retentionDays).sort((a: number, b: number) => a - b)).toEqual([7, 30, 90]);
    const defaultPolicy = res.body.policies.find((p: { isDefault: boolean }) => p.isDefault);
    expect(defaultPolicy.retentionDays).toBe(30);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/retention-policies");
    expect(res.status).toBe(401);
  });

  it("rejects assigning a camera a retention policy from another tenant", async () => {
    const createRes = await agent.post("/cameras").send({
      name: "Policy Isolation Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
    });
    const cameraId = createRes.body.id;

    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-policy-password-123", tenantName: "Other Policy Tenant" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);
    const otherPolicies = await otherAgent.get("/retention-policies");
    const foreignPolicyId = otherPolicies.body.policies[0].id;

    const patchRes = await agent.patch(`/cameras/${cameraId}`).send({ retentionPolicyId: foreignPolicyId });
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.error).toBe("invalid_retention_policy");
  });

  it("new segments pick up the camera's assigned policy, independent of the tenant default", async () => {
    const createRes = await agent.post("/cameras").send({
      name: "Policy Assignment Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    const cameraId = createRes.body.id;

    const policiesRes = await agent.get("/retention-policies");
    const sevenDayPolicy = policiesRes.body.policies.find((p: { retentionDays: number }) => p.retentionDays === 7);
    await agent.patch(`/cameras/${cameraId}`).send({ retentionPolicyId: sevenDayPolicy.id });

    await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    await new Promise((r) => setTimeout(r, 12000));
    await agent.post(`/cameras/${cameraId}/recording/stop`);

    const segments = await prisma.recordingSegment.findMany({ where: { cameraId } });
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of segments) {
      const diffDays =
        (segment.retentionExpiresAt!.getTime() - segment.startedAt.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeCloseTo(7, 1);
    }
  }, 20000);

  it(
    "enforceRetention deletes the real S3 object for an expired segment, leaves an unset-policy segment untouched",
    async () => {
      const camera = await prisma.camera.create({
        data: { tenantId, name: "Enforcement Cam", connectorType: "SIMULATED", host: "localhost", port: 8554 },
      });
      const job = await prisma.recordingJob.create({
        data: { cameraId: camera.id, tenantId, status: "STOPPED" },
      });

      // Upload real (tiny) objects directly so this test doesn't need to
      // wait on a real recording — the point here is retention logic, which
      // is already proven to work against real recorded segments above.
      const { uploadRecordingSegment } = await import("../lib/storage.js");

      const expiredKey = `tenants/${tenantId}/cameras/${camera.id}/recordings/test/expired-${randomUUID()}.mp4`;
      await uploadRecordingSegment(expiredKey, Buffer.from("expired segment content"));
      const expiredSegment = await prisma.recordingSegment.create({
        data: {
          tenantId,
          cameraId: camera.id,
          jobId: job.id,
          startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          objectKey: expiredKey,
          fileSizeBytes: 24n,
          status: "COMPLETE",
          retentionExpiresAt: new Date(Date.now() - 1000),
        },
      });

      const noPolicyKey = `tenants/${tenantId}/cameras/${camera.id}/recordings/test/nopolicy-${randomUUID()}.mp4`;
      await uploadRecordingSegment(noPolicyKey, Buffer.from("no policy segment content"));
      const noPolicySegment = await prisma.recordingSegment.create({
        data: {
          tenantId,
          cameraId: camera.id,
          jobId: job.id,
          startedAt: new Date(),
          objectKey: noPolicyKey,
          fileSizeBytes: 24n,
          status: "COMPLETE",
          retentionExpiresAt: null,
        },
      });

      const result = await enforceRetention();
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      const expiredAfter = await prisma.recordingSegment.findUniqueOrThrow({ where: { id: expiredSegment.id } });
      expect(expiredAfter.status).toBe("DELETED");
      expect(await s3ObjectExists(expiredKey)).toBe(false);

      const noPolicyAfter = await prisma.recordingSegment.findUniqueOrThrow({ where: { id: noPolicySegment.id } });
      expect(noPolicyAfter.status).toBe("COMPLETE");
      expect(await s3ObjectExists(noPolicyKey)).toBe(true);

      // Clean up the still-existing object this test intentionally left behind.
      const { deleteStorageObject } = await import("../lib/storage.js");
      await deleteStorageObject(noPolicyKey);
    },
    15000,
  );
});

describe("storage usage", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/storage/usage");
    expect(res.status).toBe(401);
  });

  it("reflects real uploaded segment sizes and is isolated per tenant", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "storage-usage-password-123", tenantName: "Storage Usage Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const emptyUsage = await agent.get("/storage/usage");
    expect(emptyUsage.body).toEqual({ totalBytes: "0", byCamera: [] });

    const createRes = await agent.post("/cameras").send({
      name: "Storage Usage Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    const cameraId = createRes.body.id;

    await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    await new Promise((r) => setTimeout(r, 12000));
    await agent.post(`/cameras/${cameraId}/recording/stop`);

    const usageRes = await agent.get("/storage/usage");
    expect(usageRes.status).toBe(200);
    expect(BigInt(usageRes.body.totalBytes)).toBeGreaterThan(0n);
    expect(usageRes.body.byCamera).toHaveLength(1);
    expect(usageRes.body.byCamera[0].cameraName).toBe("Storage Usage Cam");

    // Independently verify against the real DB sum, not just "the route
    // returned something."
    const segments = await prisma.recordingSegment.findMany({ where: { cameraId } });
    const dbSum = segments.reduce((sum, s) => sum + BigInt(s.fileSizeBytes ?? 0n), 0n);
    expect(BigInt(usageRes.body.totalBytes)).toBe(dbSum);

    // A second, unrelated tenant must see zero — not this tenant's data.
    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-storage-password-123", tenantName: "Other Storage Tenant" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);
    const otherUsage = await otherAgent.get("/storage/usage");
    expect(otherUsage.body).toEqual({ totalBytes: "0", byCamera: [] });
  }, 20000);
});
