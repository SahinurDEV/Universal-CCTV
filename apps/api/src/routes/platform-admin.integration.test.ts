import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const password = "platform-admin-test-pw-1";

async function register(tenantName: string) {
  const agent = request.agent(app);
  const email = `pa-${randomUUID()}@example.com`;
  const res = await agent.post("/auth/register").send({ email, password, tenantName });
  expect(res.status).toBe(201);
  userIds.push(res.body.user.id);
  tenantIds.push(res.body.tenant.id);
  return { agent, email, userId: res.body.user.id as string, tenantId: res.body.tenant.id as string };
}

let admin: Awaited<ReturnType<typeof register>>;
let owner: Awaited<ReturnType<typeof register>>;
let other: Awaited<ReturnType<typeof register>>;

beforeAll(async () => {
  admin = await register("PA Admin Home");
  owner = await register("PA Customer");
  other = await register("PA Other");
  // Simulates `pnpm admin:grant` (the CLI is the only writer of this flag).
  await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { targetId: { in: [...userIds, ...tenantIds] } }] } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("platform admin access control", () => {
  it("workspace OWNERs are not platform admins", async () => {
    for (const path of ["/platform-admin/stats", "/platform-admin/tenants", "/platform-admin/users", "/platform-admin/cameras", "/platform-admin/audit"]) {
      expect((await owner.agent.get(path)).status).toBe(403);
    }
    expect((await owner.agent.post(`/platform-admin/tenants/${other.tenantId}/suspend`).send({ reason: "nope nope" })).status).toBe(403);
    expect((await request(app).get("/platform-admin/stats")).status).toBe(401);
  });

  it("there is no API to grant the role (account/profile updates ignore it)", async () => {
    await owner.agent.patch("/account/profile").send({ isPlatformAdmin: true, displayName: "Owner" });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(u.isPlatformAdmin).toBe(false);
    expect((await owner.agent.get("/auth/me")).body.user.isPlatformAdmin).toBe(false);
  });

  it("mobile bearer sessions cannot use the admin API even for an admin", async () => {
    const login = await request(app).post("/auth/mobile/login").send({ email: admin.email, password });
    const res = await request(app).get("/platform-admin/stats").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  it("PLATFORM_ADMIN_EMAILS grants access", async () => {
    const env = loadEnv();
    const prev = env.PLATFORM_ADMIN_EMAILS;
    env.PLATFORM_ADMIN_EMAILS = ` someone@else.com , ${other.email.toUpperCase()} `;
    try {
      expect((await other.agent.get("/platform-admin/stats")).status).toBe(200);
      expect((await other.agent.get("/auth/me")).body.user.isPlatformAdmin).toBe(true);
    } finally {
      env.PLATFORM_ADMIN_EMAILS = prev;
    }
    expect((await other.agent.get("/platform-admin/stats")).status).toBe(403);
  });
});

describe("platform admin views", () => {
  it("stats, tenants, users, cameras, without secrets", async () => {
    const stats = await admin.agent.get("/platform-admin/stats");
    expect(stats.status).toBe(200);
    expect(stats.body.tenants.total).toBeGreaterThanOrEqual(3);
    expect(stats.body.sessions.active).toBeGreaterThanOrEqual(1);
    expect(typeof stats.body.storage.bytes).toBe("number");

    const tenants = await admin.agent.get("/platform-admin/tenants").query({ q: "PA Customer" });
    expect(tenants.status).toBe(200);
    expect(tenants.body.tenants.map((t: { id: string }) => t.id)).toContain(owner.tenantId);

    const detail = await admin.agent.get(`/platform-admin/tenants/${owner.tenantId}`);
    expect(detail.body.members[0].email).toBe(owner.email);

    const users = await admin.agent.get("/platform-admin/users").query({ q: owner.email });
    expect(users.body.users).toHaveLength(1);
    expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    expect((await admin.agent.get("/platform-admin/cameras")).status).toBe(200);
    expect((await admin.agent.get("/platform-admin/tenants").query({ pageSize: 1000 })).status).toBe(400);
    expect((await admin.agent.get("/platform-admin/tenants/not-a-uuid")).status).toBe(404);
  });

  it("timeseries returns daily running totals and trends", async () => {
    const r = await admin.agent.get("/platform-admin/timeseries").query({ days: 14 });
    expect(r.status).toBe(200);
    expect(r.body.points).toHaveLength(14);
    const last = r.body.points[13];
    expect(last.day).toBe(new Date().toISOString().slice(0, 10));
    expect(last.cameras).toBe(await prisma.camera.count());
    for (let i = 1; i < 14; i++) expect(r.body.points[i].cameras).toBeGreaterThanOrEqual(r.body.points[i - 1].cameras);
    expect(r.body.trends).toHaveProperty("alerts");
    expect((await admin.agent.get("/platform-admin/timeseries").query({ days: 365 })).status).toBe(400);
    expect((await owner.agent.get("/platform-admin/timeseries")).status).toBe(403);
  });

  it("filters by status and camera type", async () => {
    const act = await admin.agent.get("/platform-admin/tenants").query({ status: "active", q: "PA Customer" });
    expect(act.body.tenants.every((t: { suspendedAt: string | null }) => t.suspendedAt === null)).toBe(true);
    const sus = await admin.agent.get("/platform-admin/users").query({ status: "suspended" });
    expect(sus.body.users.every((u: { suspendedAt: string | null }) => u.suspendedAt !== null)).toBe(true);
    const cams = await admin.agent.get("/platform-admin/cameras").query({ type: "SIMULATED" });
    expect(cams.body.cameras.every((c: { connectorType: string }) => c.connectorType === "SIMULATED")).toBe(true);
    expect((await admin.agent.get("/platform-admin/cameras").query({ type: "BOGUS" })).status).toBe(400);
  });
});

describe("suspension", () => {
  it("suspending a workspace blocks its members and is audit-logged; unsuspend restores", async () => {
    expect((await admin.agent.post(`/platform-admin/tenants/${owner.tenantId}/suspend`).send({ reason: "x" })).status).toBe(400);
    const s = await admin.agent.post(`/platform-admin/tenants/${owner.tenantId}/suspend`).send({ reason: "Unpaid invoice" });
    expect(s.status).toBe(200);
    expect((await admin.agent.post(`/platform-admin/tenants/${owner.tenantId}/suspend`).send({ reason: "again!" })).status).toBe(409);

    const cams = await owner.agent.get("/cameras");
    expect(cams.status).toBe(403);
    expect(cams.body.error).toBe("tenant_suspended");
    const me = await owner.agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.tenants[0].suspended).toBe(true);

    const log = await prisma.platformAuditLog.findFirst({ where: { action: "tenant.suspend", targetId: owner.tenantId } });
    expect(log?.actorUserId).toBe(admin.userId);
    expect(log?.metadata).toMatchObject({ reason: "Unpaid invoice" });

    expect((await admin.agent.post(`/platform-admin/tenants/${owner.tenantId}/unsuspend`)).status).toBe(200);
    expect((await owner.agent.get("/cameras")).status).toBe(200);
    expect(await prisma.platformAuditLog.count({ where: { action: "tenant.unsuspend", targetId: owner.tenantId } })).toBe(1);
  });

  it("suspending a user revokes sessions and blocks login (only after a correct password)", async () => {
    const mobile = await request(app).post("/auth/mobile/login").send({ email: owner.email, password });
    const res = await admin.agent.post(`/platform-admin/users/${owner.userId}/suspend`).send({ reason: "Abuse report" });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBeGreaterThanOrEqual(2);

    expect((await owner.agent.get("/auth/me")).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Authorization", `Bearer ${mobile.body.token}`)).status).toBe(401);
    const wrong = await request(app).post("/auth/login").send({ email: owner.email, password: "wrong-password-xx" });
    expect(wrong.status).toBe(401);
    const right = await request(app).post("/auth/login").send({ email: owner.email, password });
    expect(right.status).toBe(403);
    expect(right.body.error).toBe("account_suspended");

    expect((await admin.agent.post(`/platform-admin/users/${owner.userId}/unsuspend`)).status).toBe(200);
    expect((await request(app).post("/auth/login").send({ email: owner.email, password })).status).toBe(200);
    const actions = (await admin.agent.get("/platform-admin/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.suspend", "user.unsuspend"]));
  });

  it("admins cannot suspend themselves or other platform admins", async () => {
    expect((await admin.agent.post(`/platform-admin/users/${admin.userId}/suspend`).send({ reason: "oops self" })).status).toBe(400);
    await prisma.user.update({ where: { id: other.userId }, data: { isPlatformAdmin: true } });
    expect((await admin.agent.post(`/platform-admin/users/${other.userId}/suspend`).send({ reason: "rival admin" })).status).toBe(403);
    await prisma.user.update({ where: { id: other.userId }, data: { isPlatformAdmin: false } });
  });
});
