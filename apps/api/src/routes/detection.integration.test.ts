import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { checkMotionForAllCameras, type Analyzer } from "../recording/motion.js";
import { removePathIfExists } from "../connectors/mediamtx-client.js";
import { detectObjects, modelPath } from "../lib/detector.js";
import { jpegToDetectorInput } from "../lib/snapshot.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const other = request.agent(app);
let cameraId = "";
// Tiny valid JPEG stand-in for a captured frame.
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const personFrame: Analyzer = async () => ({ jpeg: JPEG, detections: [{ label: "person", category: "person", score: 0.93 }] });
const carFrame: Analyzer = async () => ({ jpeg: JPEG, detections: [{ label: "car", category: "vehicle", score: 0.81 }] });
const emptyFrame: Analyzer = async () => ({ jpeg: JPEG, detections: [] });
const noDetector: Analyzer = async () => ({ jpeg: null, detections: null });
const motion = async () => ({ maxScore: 0.9, frames: 16 });

async function register(agent: ReturnType<typeof request.agent>, name: string) {
  const res = await agent.post("/auth/register").send({ email: `det-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: name });
  userIds.push(res.body.user.id);
  tenantIds.push(res.body.tenant.id);
}

async function resetAlerts() {
  await prisma.notification.deleteMany({ where: { tenantId: tenantIds[0] } });
}

beforeAll(async () => {
  await register(owner, "Detect Co");
  await register(other, "Detect Other");
  const cam = await owner.post("/cameras").send({ name: "Gate", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  cameraId = cam.body.id;
});

afterAll(async () => {
  await removePathIfExists(cameraId).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("alert classes", () => {
  it("validates and stores alert classes", async () => {
    expect((await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: ["cat"] })).status).toBe(400);
    expect((await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: [] })).status).toBe(400);
    const res = await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, sensitivity: 80, alertClasses: ["person"] });
    expect(res.status).toBe(200);
    expect(res.body.alertClasses).toEqual(["person"]);
  });

  it("person-only: a car is recorded but not alerted; a person raises PERSON_DETECTED with snapshot", async () => {
    await resetAlerts();
    await checkMotionForAllCameras(motion, carFrame);
    expect(await prisma.notification.count({ where: { tenantId: tenantIds[0] } })).toBe(0);

    await checkMotionForAllCameras(motion, personFrame);
    const alerts = await prisma.notification.findMany({ where: { tenantId: tenantIds[0] } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "PERSON_DETECTED", targetId: cameraId });
    expect(alerts[0]!.message).toContain("person");
    expect(alerts[0]!.eventId).toBeTruthy();

    const events = await owner.get(`/cameras/${cameraId}/motion/events`);
    expect(events.body.events[0].labels[0]).toMatchObject({ label: "person" });
    expect(events.body.events[0].hasSnapshot).toBe(true);
    expect(events.body.events[1].labels[0]).toMatchObject({ label: "car" });

    // Snapshot is served via a short-lived signed URL, own tenant only.
    const snap = await owner.get(`/motion-events/${alerts[0]!.eventId}/snapshot`);
    expect(snap.status).toBe(200);
    const body = Buffer.from(await (await fetch(snap.body.url)).arrayBuffer());
    expect(body.equals(JPEG)).toBe(true);
    expect((await other.get(`/motion-events/${alerts[0]!.eventId}/snapshot`)).status).toBe(404);
    expect((await request(app).get(`/motion-events/${alerts[0]!.eventId}/snapshot`)).status).toBe(401);
  });

  it("vehicle class raises VEHICLE_DETECTED; empty frame with 'any' raises plain motion", async () => {
    await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: ["vehicle"] });
    await resetAlerts();
    await checkMotionForAllCameras(motion, emptyFrame);
    expect(await prisma.notification.count({ where: { tenantId: tenantIds[0] } })).toBe(0);
    await checkMotionForAllCameras(motion, carFrame);
    expect((await prisma.notification.findFirst({ where: { tenantId: tenantIds[0] } }))?.type).toBe("VEHICLE_DETECTED");

    await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: ["any"] });
    await resetAlerts();
    await checkMotionForAllCameras(motion, emptyFrame);
    expect((await prisma.notification.findFirst({ where: { tenantId: tenantIds[0] } }))?.type).toBe("MOTION_DETECTED");
  });

  it("falls back to a plain motion alert when the detector is unavailable, even if person-only", async () => {
    await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: ["person"] });
    await resetAlerts();
    await checkMotionForAllCameras(motion, noDetector);
    const a = await prisma.notification.findFirst({ where: { tenantId: tenantIds[0] } });
    expect(a?.type).toBe("MOTION_DETECTED");
    const ev = await prisma.motionEvent.findFirst({ where: { cameraId }, orderBy: { detectedAt: "desc" } });
    expect(ev?.labels).toBeNull();
    expect(ev?.snapshotKey).toBeNull();
    await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: false });
  });
});

// Real model on a real photo — runs when the model has been downloaded
// (pnpm --filter @cctv/api model:download) and the test image exists.
const PHOTO = process.env.DETECTION_TEST_IMAGE ?? "/tmp/od/bus.jpg";
describe.skipIf(!existsSync(modelPath()) || !existsSync(PHOTO))("real object detection", () => {
  it("finds a person in a photo of people", async () => {
    const rgb = await jpegToDetectorInput(await readFile(PHOTO));
    const detections = await detectObjects(new Uint8Array(rgb));
    expect(detections?.some((d) => d.label === "person" && d.score > 0.5)).toBe(true);
  }, 30000);
});
