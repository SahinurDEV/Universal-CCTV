import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { checkMotionForAllCameras, type Analyzer } from "../recording/motion.js";
import { removePathIfExists } from "../connectors/mediamtx-client.js";
import { sampleMotion } from "../lib/motion.js";
import { buildMaskPgm } from "../lib/zones.js";
import { detectObjects, MODELS, resetDetectorForTests } from "../lib/detector.js";
import { jpegToDetectorInput } from "../lib/snapshot.js";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
const viewer = request.agent(app);
let cameraId = "";
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const motion = async () => ({ maxScore: 0.9, frames: 16 });
// A person standing in the LEFT half, a car in the RIGHT half.
const personLeft = { label: "person", category: "person" as const, score: 0.7, box: [0.1, 0.3, 0.15, 0.5] as [number, number, number, number] };
const carRight = { label: "car", category: "vehicle" as const, score: 0.9, box: [0.6, 0.5, 0.3, 0.3] as [number, number, number, number] };
const both: Analyzer = async () => ({ jpeg: JPEG, detections: [personLeft, carRight] });
const leftZone = { id: "drive", name: "Driveway", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] };
const rightZone = { id: "street", name: "Street", points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] };

const alerts = () => prisma.notification.findMany({ where: { tenantId: tenantIds[0] }, orderBy: { createdAt: "asc" } });
const reset = () => prisma.notification.deleteMany({ where: { tenantId: tenantIds[0] } });

beforeAll(async () => {
  const r = await owner.post("/auth/register").send({ email: `zone-${randomUUID()}@example.com`, password: "correct-horse-battery-staple", tenantName: "Zones Co" });
  userIds.push(r.body.user.id);
  tenantIds.push(r.body.tenant.id);
  const cam = await owner.post("/cameras").send({ name: "Yard", connectorType: "SIMULATED", host: "localhost", port: 8554, credential: { path: "simulated" } });
  cameraId = cam.body.id;
  await owner.put(`/cameras/${cameraId}/motion`).send({ enabled: true, alertClasses: ["person", "vehicle"] });
  // Viewer member.
  const vEmail = `zone-viewer-${randomUUID()}@example.com`;
  const vr = await viewer.post("/auth/register").send({ email: vEmail, password: "correct-horse-battery-staple", tenantName: "Viewer own" });
  userIds.push(vr.body.user.id);
  tenantIds.push(vr.body.tenant.id);
  await prisma.membership.create({ data: { tenantId: tenantIds[0]!, userId: vr.body.user.id, role: "VIEWER" } });
  await viewer.post("/auth/switch-tenant").send({ tenantId: tenantIds[0] });
});

afterAll(async () => {
  await removePathIfExists(cameraId).catch(() => undefined);
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("detection settings API", () => {
  it("defaults, validation and role checks", async () => {
    const g = await owner.get(`/cameras/${cameraId}/detection`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ zones: [], schedule: null, timezone: "UTC", alertsActiveNow: true });
    expect(g.body.model.id).toBe(loadEnv().DETECTION_MODEL);

    expect((await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [{ ...leftZone, points: [[0, 0], [2, 2], [0, 1]] }] })).status).toBe(400);
    expect((await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [leftZone, leftZone] })).status).toBe(400);
    expect((await owner.put(`/cameras/${cameraId}/detection`).send({ thresholds: { person: 0.05 } })).status).toBe(400);
    expect((await owner.put(`/cameras/${cameraId}/detection`).send({ thresholds: { cat: 0.5 } })).status).toBe(400);
    expect((await owner.put(`/cameras/${cameraId}/detection`).send({ extra: 1 })).status).toBe(400);
    expect((await viewer.get(`/cameras/${cameraId}/detection`)).status).toBe(200);
    expect((await viewer.put(`/cameras/${cameraId}/detection`).send({ zones: [leftZone] })).status).toBe(403);

    const ok = await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [leftZone], thresholds: { person: 0.6 } });
    expect(ok.status).toBe(200);
    expect(ok.body.zones).toHaveLength(1);
    expect(ok.body.thresholds).toEqual({ person: 0.6 });
    expect(await prisma.auditLog.count({ where: { tenantId: tenantIds[0], action: "camera.detection.update" } })).toBe(1);
  });

  it("workspace timezone (owner/admin only, validated)", async () => {
    expect((await viewer.put("/workspace/timezone").send({ timezone: "Asia/Dhaka" })).status).toBe(403);
    expect((await owner.put("/workspace/timezone").send({ timezone: "Mars/Base" })).status).toBe(400);
    const r = await owner.put("/workspace/timezone").send({ timezone: "Asia/Dhaka" });
    expect(r.body.timezone).toBe("Asia/Dhaka");
    expect((await owner.get("/workspace")).body.timezone).toBe("Asia/Dhaka");
  });
});

describe("worker honours zones, thresholds and schedules", () => {
  it("only the object inside a zone counts", async () => {
    await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [leftZone], thresholds: null });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    let a = await alerts();
    expect(a.map((n) => n.type)).toEqual(["PERSON_DETECTED"]);
    const ev = await prisma.motionEvent.findUniqueOrThrow({ where: { id: a[0]!.eventId! } });
    expect((ev.labels as { label: string }[]).map((l) => l.label)).toEqual(["person"]);

    await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [rightZone] });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    a = await alerts();
    expect(a.map((n) => n.type)).toEqual(["VEHICLE_DETECTED"]);
  });

  it("per-class thresholds drop low-confidence objects", async () => {
    await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [], thresholds: { person: 0.8, vehicle: 0.95 } });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    expect(await alerts()).toHaveLength(0); // person 0.7 < 0.8, car 0.9 < 0.95
    await owner.put(`/cameras/${cameraId}/detection`).send({ thresholds: { person: 0.65 } });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    expect((await alerts())[0]?.type).toBe("PERSON_DETECTED");
  });

  it("outside the schedule events are recorded but no alert is sent", async () => {
    await owner.put(`/cameras/${cameraId}/detection`).send({ thresholds: null, schedule: { enabled: true, windows: [] } });
    const before = await prisma.motionEvent.count({ where: { cameraId } });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    expect(await alerts()).toHaveLength(0);
    expect(await prisma.motionEvent.count({ where: { cameraId } })).toBe(before + 1);
    expect((await owner.get(`/cameras/${cameraId}/detection`)).body.alertsActiveNow).toBe(false);

    await owner.put(`/cameras/${cameraId}/detection`).send({
      schedule: { enabled: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }] },
    });
    await reset();
    await checkMotionForAllCameras(motion, both, [cameraId]);
    expect((await alerts()).length).toBe(1);
    await owner.put(`/cameras/${cameraId}/detection`).send({ schedule: null });
  });

  it("the sampler receives a zone mask", async () => {
    await owner.put(`/cameras/${cameraId}/detection`).send({ zones: [leftZone] });
    let seen: string | undefined;
    await checkMotionForAllCameras(async (_u, _s, opts) => {
      seen = opts?.maskPath;
      return { maxScore: 0, frames: 4 };
    }, both, [cameraId]);
    expect(seen && existsSync(seen)).toBe(true);
    expect((await readFile(seen!)).subarray(0, 2).toString()).toBe("P5");
  });
});

describe("real ffmpeg with a zone mask (fake camera)", () => {
  it("samples scene scores through the mask", async () => {
    const mask = join(tmpdir(), `zone-test-${randomUUID()}.pgm`);
    await writeFile(mask, buildMaskPgm([leftZone as never]).pgm);
    const url = `${loadEnv().MEDIAMTX_RTSP_URL.replace(/\/$/, "")}/simulated`;
    const r = await sampleMotion(url, 2, { maskPath: mask });
    expect(r.frames).toBeGreaterThan(3);
  }, 30000);
});

const RTDETR = resolve(process.cwd(), MODELS["rtdetr-r18"].defaultPath);
const PHOTO = process.env.DETECTION_TEST_IMAGE ?? "/tmp/od/bus.jpg";
describe.skipIf(!existsSync(RTDETR) || !existsSync(PHOTO))("optional RT-DETR detector (real model)", () => {
  it("finds the people and the bus, with boxes", async () => {
    const env = loadEnv();
    const prev = env.DETECTION_MODEL;
    env.DETECTION_MODEL = "rtdetr-r18";
    resetDetectorForTests();
    try {
      const rgb = await jpegToDetectorInput(await readFile(PHOTO));
      expect(rgb.length).toBe(640 * 640 * 3);
      const d = await detectObjects(new Uint8Array(rgb), 0.5);
      expect(d!.filter((x) => x.label === "person").length).toBeGreaterThanOrEqual(3);
      expect(d!.some((x) => x.label === "bus")).toBe(true);
      expect(d!.every((x) => x.box && x.box.every((v) => v >= 0 && v <= 1))).toBe(true);
    } finally {
      env.DETECTION_MODEL = prev;
      resetDetectorForTests();
    }
  }, 60000);
});
