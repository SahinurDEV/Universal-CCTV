import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";

const app = createApp();
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

function uniqueEmail() {
  return `test-${randomUUID()}@example.com`;
}

async function createSimulatedCamera(agent: ReturnType<typeof request.agent>, name: string) {
  const res = await agent.post("/cameras").send({
    name,
    connectorType: "SIMULATED",
    host: "localhost",
    port: 8554,
    credential: { path: "/simulated" },
  });
  return res.body.id as string;
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

describe("recording start/stop against the real simulated RTSP stream", () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "recording-test-password-123", tenantName: "Recording Test Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    // This describe block creates several cameras under one tenant — well
    // beyond the free trial's 2-camera limit. Quota enforcement itself has
    // its own dedicated test; upgrading here keeps that concern from
    // coupling into unrelated recording-pipeline tests.
    await agent.post("/subscription/change").send({ planKey: "pro" });
  });

  it(
    "records real segments, uploads them to S3, and writes accurate metadata",
    async () => {
      const cameraId = await createSimulatedCamera(agent, "Recording Integration Cam");

      const startRes = await agent
        .post(`/cameras/${cameraId}/recording/start`)
        .send({ segmentSeconds: 10 });
      expect(startRes.status).toBe(201);
      expect(startRes.body.status).toBe("RUNNING");
      const jobId = startRes.body.jobId;

      // Let MediaMTX actually write at least one full 10s segment before we
      // stop — this is real wall-clock time against a real stream, not a
      // mock, same as the rest of this test suite's RTSP tests.
      await new Promise((r) => setTimeout(r, 13000));

      const stopRes = await agent.post(`/cameras/${cameraId}/recording/stop`);
      expect(stopRes.status).toBe(200);
      expect(stopRes.body.status).toBe("STOPPED");
      expect(stopRes.body.ingested).toBeGreaterThanOrEqual(1);
      expect(stopRes.body.failed).toBe(0);

      const job = await prisma.recordingJob.findUnique({ where: { id: jobId } });
      expect(job?.status).toBe("STOPPED");
      expect(job?.stoppedAt).not.toBeNull();

      const segments = await prisma.recordingSegment.findMany({ where: { jobId } });
      expect(segments.length).toBeGreaterThanOrEqual(1);

      for (const segment of segments) {
        expect(segment.status).toBe("COMPLETE");
        expect(segment.durationSec).toBeGreaterThan(0);
        // A real video segment at this bitrate is comfortably more than a
        // few KB per second — this is the same "did we actually get real
        // video" check the ingestion code itself applies before persisting.
        expect(Number(segment.fileSizeBytes)).toBeGreaterThan(10_000);
        // Independently confirm the object is really in S3, not just that
        // uploadRecordingSegment() didn't throw.
        expect(await s3ObjectExists(segment.objectKey)).toBe(true);
      }
    },
    30000,
  );

  it("rejects starting a second recording while one is already active", async () => {
    const cameraId = await createSimulatedCamera(agent, "Duplicate Start Cam");

    const first = await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    expect(first.status).toBe(201);

    const second = await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("recording_already_active");

    const stopRes = await agent.post(`/cameras/${cameraId}/recording/stop`);
    expect(stopRes.status).toBe(200);
  }, 15000);

  it("404s stopping a camera with no active recording", async () => {
    const cameraId = await createSimulatedCamera(agent, "No Active Recording Cam");
    const res = await agent.post(`/cameras/${cameraId}/recording/stop`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_active_recording");
  });

  it("blocks another tenant from starting/stopping recording on this camera", async () => {
    const cameraId = await createSimulatedCamera(agent, "Isolation Recording Cam");

    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-tenant-password-123", tenantName: "Other Recording Tenant" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);

    const startRes = await otherAgent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    expect(startRes.status).toBe(404);

    const stopRes = await otherAgent.post(`/cameras/${cameraId}/recording/stop`);
    expect(stopRes.status).toBe(404);
  });
});
