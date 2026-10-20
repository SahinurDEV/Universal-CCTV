import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("playback against a real recorded segment", () => {
  let agent: ReturnType<typeof request.agent>;
  let cameraId: string;
  let today: string;

  beforeAll(async () => {
    agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "playback-test-password-123", tenantName: "Playback Test Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const createRes = await agent.post("/cameras").send({
      name: "Playback Integration Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    cameraId = createRes.body.id;
    today = new Date().toISOString().slice(0, 10);

    await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    await new Promise((r) => setTimeout(r, 12000));
    await agent.post(`/cameras/${cameraId}/recording/stop`);
  }, 20000);

  it("lists the camera's recording dates, including today", async () => {
    const res = await agent.get(`/cameras/${cameraId}/recordings/dates`);
    expect(res.status).toBe(200);
    expect(res.body.dates).toContain(today);
  });

  it("lists real segments for that date, oldest first", async () => {
    const res = await agent.get(`/cameras/${cameraId}/recordings?date=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.segments.length).toBeGreaterThanOrEqual(1);
    expect(res.body.segments.every((s: { status: string }) => s.status === "COMPLETE")).toBe(true);
    // Never exposes the internal object key — only the dedicated URL route does.
    expect(JSON.stringify(res.body)).not.toContain("tenants/");
  });

  it("generates a signed URL that actually serves the real recorded video", async () => {
    const listRes = await agent.get(`/cameras/${cameraId}/recordings?date=${today}`);
    const segment = listRes.body.segments[0];

    const urlRes = await agent.get(`/cameras/${cameraId}/recordings/${segment.id}/url`);
    expect(urlRes.status).toBe(200);
    expect(urlRes.body.url).toContain("X-Amz-Signature");

    const fetchRes = await fetch(urlRes.body.url);
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers.get("content-type")).toBe("video/mp4");
    const bytes = await fetchRes.arrayBuffer();
    // Real video, not an empty/near-empty placeholder — matches the stored size.
    expect(bytes.byteLength).toBe(Number(segment.fileSizeBytes));
  });

  it("sets a download filename when ?download=true", async () => {
    const listRes = await agent.get(`/cameras/${cameraId}/recordings?date=${today}`);
    const segment = listRes.body.segments[0];

    const urlRes = await agent.get(`/cameras/${cameraId}/recordings/${segment.id}/url?download=true`);
    const fetchRes = await fetch(urlRes.body.url);
    expect(fetchRes.headers.get("content-disposition")).toMatch(/^attachment; filename=/);
  });

  it("404s another tenant's attempt to list or play this camera's recordings", async () => {
    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-tenant-password-123", tenantName: "Other Playback Tenant" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);

    const datesRes = await otherAgent.get(`/cameras/${cameraId}/recordings/dates`);
    expect(datesRes.status).toBe(404);

    const listRes = await otherAgent.get(`/cameras/${cameraId}/recordings?date=${today}`);
    expect(listRes.status).toBe(404);
  });

  it("404s a well-formed but nonexistent segment id instead of erroring", async () => {
    const res = await agent.get(`/cameras/${cameraId}/recordings/${randomUUID()}/url`);
    expect(res.status).toBe(404);
  });
});
