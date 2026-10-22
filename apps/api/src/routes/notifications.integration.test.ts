import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { notifyOnce } from "../lib/notifications.js";
import { checkCameraHealth } from "../recording/health.js";

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

describe("notifyOnce de-duplication", () => {
  it("creates a notification the first time, then suppresses an identical one within the cooldown", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Notify Dedup Tenant" } });
    createdTenantIds.push(tenant.id);
    const cameraId = randomUUID();

    const first = await notifyOnce({
      tenantId: tenant.id,
      type: "CAMERA_OFFLINE",
      targetId: cameraId,
      message: "first",
      cooldownMinutes: 30,
    });
    expect(first).toBe(true);

    const second = await notifyOnce({
      tenantId: tenant.id,
      type: "CAMERA_OFFLINE",
      targetId: cameraId,
      message: "second — should be suppressed",
      cooldownMinutes: 30,
    });
    expect(second).toBe(false);

    const rows = await prisma.notification.findMany({ where: { tenantId: tenant.id, targetId: cameraId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("first");
  });

  it("does not suppress a different target or a different type for the same tenant", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Notify Dedup Scope Tenant" } });
    createdTenantIds.push(tenant.id);
    const cameraA = randomUUID();
    const cameraB = randomUUID();

    await notifyOnce({ tenantId: tenant.id, type: "CAMERA_OFFLINE", targetId: cameraA, message: "a", cooldownMinutes: 30 });
    const differentTarget = await notifyOnce({
      tenantId: tenant.id,
      type: "CAMERA_OFFLINE",
      targetId: cameraB,
      message: "b",
      cooldownMinutes: 30,
    });
    const differentType = await notifyOnce({
      tenantId: tenant.id,
      type: "RECORDING_STOPPED",
      targetId: cameraA,
      message: "c",
      cooldownMinutes: 30,
    });

    expect(differentTarget).toBe(true);
    expect(differentType).toBe(true);
  });
});

describe("notifications API", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/notifications");
    expect(res.status).toBe(401);
  });

  it("lists a tenant's own notifications, isolated from other tenants, and supports mark-read", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "notif-api-password-123", tenantName: "Notif API Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    await notifyOnce({
      tenantId: reg.body.tenant.id,
      type: "STORAGE_QUOTA_WARNING",
      targetId: null,
      message: "Usage is high.",
      cooldownMinutes: 1,
    });

    const listRes = await agent.get("/notifications");
    expect(listRes.status).toBe(200);
    expect(listRes.body.notifications).toHaveLength(1);
    expect(listRes.body.unreadCount).toBe(1);

    const notificationId = listRes.body.notifications[0].id;
    const readRes = await agent.post(`/notifications/${notificationId}/read`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.readAt).not.toBeNull();

    const afterRead = await agent.get("/notifications");
    expect(afterRead.body.unreadCount).toBe(0);

    // A second, unrelated tenant must see none of this.
    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "other-notif-password-123", tenantName: "Other Notif Tenant" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);
    const otherList = await otherAgent.get("/notifications");
    expect(otherList.body.notifications).toHaveLength(0);
  });

  it("404s marking another tenant's notification as read", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "notif-isolation-password-123", tenantName: "Notif Isolation Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);
    await notifyOnce({
      tenantId: reg.body.tenant.id,
      type: "UPLOAD_FAILURE",
      targetId: null,
      message: "x",
      cooldownMinutes: 1,
    });
    const notificationId = (await agent.get("/notifications")).body.notifications[0].id;

    const otherAgent = request.agent(app);
    const otherReg = await otherAgent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "notif-isolation-2-password-123", tenantName: "Notif Isolation Tenant 2" });
    createdUserIds.push(otherReg.body.user.id);
    createdTenantIds.push(otherReg.body.tenant.id);

    const res = await otherAgent.post(`/notifications/${notificationId}/read`);
    expect(res.status).toBe(404);
  });
});

describe("camera health checks against the real simulated stream", () => {
  it("reports a healthy running recording with no offline notification", async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "health-check-password-123", tenantName: "Health Check Integration Tenant" });
    createdUserIds.push(reg.body.user.id);
    createdTenantIds.push(reg.body.tenant.id);

    const createRes = await agent.post("/cameras").send({
      name: "Health Check Integration Cam",
      connectorType: "SIMULATED",
      host: "localhost",
      port: 8554,
      credential: { path: "/simulated" },
    });
    const cameraId = createRes.body.id;

    const startRes = await agent.post(`/cameras/${cameraId}/recording/start`).send({ segmentSeconds: 10 });
    expect(startRes.status).toBe(201);

    // Give MediaMTX a moment to actually establish the pull before checking.
    await new Promise((r) => setTimeout(r, 2000));

    const result = await checkCameraHealth();
    expect(result.checked).toBeGreaterThanOrEqual(1);

    const notifications = await prisma.notification.findMany({ where: { targetId: cameraId } });
    expect(notifications).toHaveLength(0);

    await agent.post(`/cameras/${cameraId}/recording/stop`);
  }, 15000);
});
