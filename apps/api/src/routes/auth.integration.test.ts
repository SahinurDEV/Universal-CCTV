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
  // Cascades (Membership, Session, AuditLog) are configured onDelete:
  // Cascade in the schema, so deleting the user/tenant rows is enough.
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /auth/register", () => {
  it("creates a user + tenant + OWNER membership and sets a session cookie", async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post("/auth/register")
      .send({ email, password: "correct-horse-battery-staple", tenantName: "Acme Corp" });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.tenant.role).toBe("OWNER");
    expect(res.headers["set-cookie"]).toBeDefined();

    createdUserIds.push(res.body.user.id);
    createdTenantIds.push(res.body.tenant.id);
  });

  it("rejects a duplicate email with 409", async () => {
    const email = uniqueEmail();
    const first = await request(app)
      .post("/auth/register")
      .send({ email, password: "correct-horse-battery-staple", tenantName: "Acme Corp" });
    createdUserIds.push(first.body.user.id);
    createdTenantIds.push(first.body.tenant.id);

    const second = await request(app)
      .post("/auth/register")
      .send({ email, password: "another-password-here", tenantName: "Other Co" });

    expect(second.status).toBe(409);
  });

  it("rejects a short password with 400", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "short", tenantName: "Acme Corp" });
    expect(res.status).toBe(400);
  });
});

describe("full auth lifecycle", () => {
  it("register -> me -> logout -> me(401) -> login -> me", async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();
    const password = "correct-horse-battery-staple";

    const registerRes = await agent
      .post("/auth/register")
      .send({ email, password, tenantName: "Lifecycle Co" });
    expect(registerRes.status).toBe(201);
    createdUserIds.push(registerRes.body.user.id);
    createdTenantIds.push(registerRes.body.tenant.id);

    const meRes = await agent.get("/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(email);
    expect(meRes.body.activeTenantId).toBe(registerRes.body.tenant.id);

    const logoutRes = await agent.post("/auth/logout");
    expect(logoutRes.status).toBe(204);

    const meAfterLogout = await agent.get("/auth/me");
    expect(meAfterLogout.status).toBe(401);

    const loginAgent = request.agent(app);
    const loginRes = await loginAgent.post("/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.activeTenantId).toBe(registerRes.body.tenant.id);

    const meAfterLogin = await loginAgent.get("/auth/me");
    expect(meAfterLogin.status).toBe(200);
  });

  it("rejects login with the wrong password", async () => {
    const email = uniqueEmail();
    const registerRes = await request(app)
      .post("/auth/register")
      .send({ email, password: "correct-horse-battery-staple", tenantName: "Wrong Pw Co" });
    createdUserIds.push(registerRes.body.user.id);
    createdTenantIds.push(registerRes.body.tenant.id);

    const loginRes = await request(app).post("/auth/login").send({ email, password: "nope-not-it" });
    expect(loginRes.status).toBe(401);
  });

  it("rejects login for a nonexistent email with the same 401 shape (no enumeration)", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: uniqueEmail(), password: "whatever-12345" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });
});

describe("GET /auth/me without a session", () => {
  it("returns 401", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });
});
