import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { checkMotionForAllCameras } from "../recording/motion.js";
import { removePathIfExists } from "../connectors/mediamtx-client.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const other = request.agent(app);
let cameraId = "";

async function register(agent: ReturnType<typeof request.agent>, name: string) {
  const res = await agent
    .post("/auth/register")
    .send({ email: `motion-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: name });
  expect(res.status).toBe(201);
  userIds.push(res.body.user.id);
  tenantIds.push(res.body.tenant.id);
  return res.body;
}

beforeAll(async () => {
  await register(owner, "Motion Owner Co");
  await register(other, "Motion Other Co");
  const cam = await owner
    .post("/cameras")
    .send({ name: "Motion Cam", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  expect(cam.status).toBe(201);
  cameraId = cam.body.id;
  expect(cam.body.motionEnabled).toBe(false);
});

afterAll(async () => {
  await removePathIfExists(cameraId).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("motion settings API", () => {
  it("returns defaults", async () => {
    const res = await owner.get(`/cameras/${cameraId}/motion`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, sensitivity: 50 });
    expect(res.body.threshold).toBeGreaterThan(0);
  });

  it("validates sensitivity range", async () => {
    const res = await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, sensitivity: 0 });
    expect(res.status).toBe(400);
    const res2 = await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, sensitivity: 101 });
    expect(res2.status).toBe(400);
  });

  it("enables motion detection", async () => {
    const res = await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, sensitivity: 80 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, sensitivity: 80 });
  });

  it("hides other tenants' cameras (404)", async () => {
    expect((await other.get(`/cameras/${cameraId}/motion`)).status).toBe(404);
    expect((await other.put(`/cameras/${cameraId}/motion`).send({ enabled: false })).status).toBe(404);
    expect((await other.get(`/cameras/${cameraId}/motion/events`)).status).toBe(404);
  });

  it("forbids VIEWERs from changing settings", async () => {
    const tenantId = tenantIds[0]!;
    const viewer = request.agent(app);
    const email = `motion-viewer-${randomUUID()}@example.com`;
    const reg = await viewer.post("/auth/register").send({ email, password: "correct-horse-battery-staple", tenantName: "tmp" });
    userIds.push(reg.body.user.id);
    tenantIds.push(reg.body.tenant.id);
    await prisma.membership.create({ data: { tenantId, userId: reg.body.user.id, role: "VIEWER" } });
    expect((await viewer.post("/auth/switch-tenant").send({ tenantId })).status).toBe(204);
    expect((await viewer.get(`/cameras/${cameraId}/motion`)).status).toBe(200);
    expect((await viewer.put(`/cameras/${cameraId}/motion`).send({ enabled: false })).status).toBe(403);
  });
});

describe("motion worker", () => {
  it("records an event + a single MOTION_DETECTED alert when the score crosses the threshold", async () => {
    const result = await checkMotionForAllCameras(async () => ({ maxScore: 0.9, frames: 16 }));
    expect(result.detected).toBeGreaterThanOrEqual(1);
    await checkMotionForAllCameras(async () => ({ maxScore: 0.9, frames: 16 }));

    const events = await owner.get(`/cameras/${cameraId}/motion/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.length).toBe(2);
    expect(events.body.events[0].cameraName).toBe("Motion Cam");

    const alerts = await prisma.notification.findMany({ where: { tenantId: tenantIds[0], type: "MOTION_DETECTED" } });
    expect(alerts).toHaveLength(1); // cooldown suppresses the second alert

    const all = await owner.get("/motion-events");
    expect(all.body.events.every((e: { cameraId: string }) => e.cameraId === cameraId)).toBe(true);
    expect((await other.get("/motion-events")).body.events).toHaveLength(0);
  });

  it("does not record anything below the threshold and stores sampler errors", async () => {
    const before = await prisma.motionEvent.count({ where: { cameraId } });
    await checkMotionForAllCameras(async () => ({ maxScore: 0.0001, frames: 16 }));
    expect(await prisma.motionEvent.count({ where: { cameraId } })).toBe(before);

    await checkMotionForAllCameras(async () => {
      throw new Error("no frames received");
    });
    const cam = await owner.get(`/cameras/${cameraId}/motion`);
    expect(cam.body.lastError).toContain("no frames");
    expect(cam.body.lastCheckedAt).not.toBeNull();
  });

  it("skips disabled cameras", async () => {
    await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: false });
    const before = await prisma.motionEvent.count({ where: { cameraId } });
    await checkMotionForAllCameras(async () => ({ maxScore: 1, frames: 1 }));
    expect(await prisma.motionEvent.count({ where: { cameraId } })).toBe(before);
  });
});
