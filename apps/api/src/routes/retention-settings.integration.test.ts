import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { enforceRetention } from "../recording/retention.js";
import { uploadObject, buildSnapshotObjectKey } from "../lib/storage.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const viewer = request.agent(app);
let tenantId = "";
const DAY = 24 * 3600 * 1000;

beforeAll(async () => {
  const r = await owner.post("/auth/register").send({ email: `ret-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: "Ret Co" });
  userIds.push(r.body.user.id);
  tenantId = r.body.tenant.id;
  tenantIds.push(tenantId);
  const v = await viewer.post("/auth/register").send({ email: `retv-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: "tmp" });
  userIds.push(v.body.user.id);
  tenantIds.push(v.body.tenant.id);
  await prisma.membership.create({ data: { tenantId, userId: v.body.user.id, role: "VIEWER" } });
  await viewer.post("/auth/switch-tenant").send({ tenantId });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("retention settings API", () => {
  it("validates, enforces roles and the plan limit", async () => {
    expect((await owner.put("/retention").send({ retentionDays: 0 })).status).toBe(400);
    expect((await owner.put("/retention").send({ retentionDays: 99999 })).status).toBe(400);
    expect((await viewer.put("/retention").send({ retentionDays: 5 })).status).toBe(403);
    const plan = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (plan) {
      expect((await owner.put("/retention").send({ retentionDays: plan.plan.maxRetentionDays + 1 })).status).toBe(402);
    }
    expect((await owner.put("/retention").send({ retentionDays: 5 })).body.workspaceRetentionDays).toBe(5);
    const view = await viewer.get("/retention");
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ workspaceRetentionDays: 5, canEdit: false });
  });

  it("per-camera override is tenant-scoped and role-checked", async () => {
    const cam = await prisma.camera.create({ data: { tenantId, name: "Override Cam", connectorType: "SIMULATED", host: "localhost", port: 8554 } });
    const other = request.agent(app);
    const r = await other.post("/auth/register").send({ email: `reto-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: "Other" });
    userIds.push(r.body.user.id);
    tenantIds.push(r.body.tenant.id);
    expect((await other.put(`/retention/cameras/${cam.id}`).send({ retentionDays: 1 })).status).toBe(404);
    expect((await viewer.put(`/retention/cameras/${cam.id}`).send({ retentionDays: 1 })).status).toBe(403);
    expect((await owner.put(`/retention/cameras/${cam.id}`).send({ retentionDays: 2 })).status).toBe(200);
    const view = await owner.get("/retention");
    expect(view.body.cameras.find((c: { cameraId: string }) => c.cameraId === cam.id)).toMatchObject({ overrideDays: 2, effectiveDays: 2 });
  });
});

describe("retention worker with day-based settings", () => {
  it("deletes recordings older than the effective days from storage and DB; keeps newer; cleans motion snapshots", async () => {
    await owner.put("/retention").send({ retentionDays: 5 });
    const camWs = await prisma.camera.create({ data: { tenantId, name: "WS Cam", connectorType: "SIMULATED", host: "localhost", port: 8554 } });
    const camOv = await prisma.camera.create({ data: { tenantId, name: "OV Cam", connectorType: "SIMULATED", host: "localhost", port: 8554, retentionDaysOverride: 10 } });
    const job = await prisma.recordingJob.create({ data: { cameraId: camWs.id, tenantId, status: "STOPPED" } });
    const job2 = await prisma.recordingJob.create({ data: { cameraId: camOv.id, tenantId, status: "STOPPED" } });
    const { uploadRecordingSegment } = await import("../lib/storage.js");
    async function seg(cameraId: string, jobId: string, ageDays: number) {
      const key = `tenants/${tenantId}/cameras/${cameraId}/recordings/test/${randomUUID()}.mp4`;
      await uploadRecordingSegment(key, Buffer.from("x"));
      return prisma.recordingSegment.create({
        data: { tenantId, cameraId, jobId, startedAt: new Date(Date.now() - ageDays * DAY), objectKey: key, fileSizeBytes: 1n, status: "COMPLETE", retentionExpiresAt: null },
      });
    }
    const wsOld = await seg(camWs.id, job.id, 7);
    const wsNew = await seg(camWs.id, job.id, 1);
    const ovMid = await seg(camOv.id, job2.id, 7); // 7 < 10-day override → kept
    const ovOld = await seg(camOv.id, job2.id, 12);

    const evId = randomUUID();
    const snapKey = buildSnapshotObjectKey(tenantId, camWs.id, evId);
    await uploadObject(snapKey, Buffer.from("jpg"), "image/jpeg");
    await prisma.motionEvent.create({ data: { id: evId, tenantId, cameraId: camWs.id, score: 0.5, threshold: 0.1, snapshotKey: snapKey, detectedAt: new Date(Date.now() - 6 * DAY) } });

    const result = await enforceRetention();
    expect(result.motionEventsDeleted).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => (await prisma.recordingSegment.findUnique({ where: { id } }))?.status;
    expect(await status(wsOld.id)).toBe("DELETED");
    expect(await status(ovOld.id)).toBe("DELETED");
    expect(await status(wsNew.id)).toBe("COMPLETE");
    expect(await status(ovMid.id)).toBe("COMPLETE");
    expect(await prisma.motionEvent.findUnique({ where: { id: evId } })).toBeNull();

    // Tombstones are purged from the database after a day.
    await prisma.recordingSegment.update({ where: { id: wsOld.id }, data: { retentionExpiresAt: new Date(Date.now() - 2 * DAY) } });
    const again = await enforceRetention();
    expect(again.purgedRows).toBeGreaterThanOrEqual(1);
    expect(await prisma.recordingSegment.findUnique({ where: { id: wsOld.id } })).toBeNull();

    const usage = await owner.get("/retention");
    expect(BigInt(usage.body.totalBytes)).toBe(2n);
  });
});
