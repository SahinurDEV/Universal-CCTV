import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { prisma } from "../lib/db.js";

const app = createApp();
const userIds: string[] = [];
const tenantIds: string[] = [];
const owner = request.agent(app);
let tenantId = "";
const PASSWORD = "correct-horse-battery-staple";

function email(tag: string) {
  return `invite-${tag}-${randomUUID()}@example.com`;
}
function tokenOf(url: string) {
  return url.split("/invite/")[1]!;
}

beforeAll(async () => {
  const res = await owner.post("/auth/register").send({ email: email("owner"), password: PASSWORD, tenantName: "Invite Co" });
  userIds.push(res.body.user.id);
  tenantId = res.body.tenant.id;
  tenantIds.push(tenantId);
});

afterAll(async () => {
  const invited = await prisma.user.findMany({ where: { email: { startsWith: "invite-" }, memberships: { some: { tenantId } } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds, ...invited.map((u) => u.id)] } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("invites", () => {
  let viewerAgent: ReturnType<typeof request.agent>;
  let adminAgent: ReturnType<typeof request.agent>;

  it("owner invites a new user who accepts by creating an account", async () => {
    const addr = email("viewer");
    const created = await owner.post("/invites").send({ email: addr.toUpperCase(), role: "VIEWER" });
    expect(created.status).toBe(201);
    expect(created.body.invite).toMatchObject({ email: addr, role: "VIEWER", state: "pending" });
    expect(created.body.emailSent).toBe(false);
    const token = tokenOf(created.body.acceptUrl);

    const row = await prisma.invite.findUniqueOrThrow({ where: { id: created.body.invite.id } });
    expect(row.tokenHash).not.toContain(token); // only the hash is stored

    const preview = await request(app).get(`/invites/token/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ email: addr, role: "VIEWER", workspaceName: "Invite Co", accountExists: false });

    viewerAgent = request.agent(app);
    expect((await viewerAgent.post("/invites/accept").send({ token })).status).toBe(400); // password required
    const accepted = await viewerAgent.post("/invites/accept").send({ token, password: PASSWORD, displayName: "Vee" });
    expect(accepted.status).toBe(200);
    const me = await viewerAgent.get("/auth/me");
    expect(me.body.activeTenantId).toBe(tenantId);
    expect(me.body.tenants[0].role).toBe("VIEWER");

    // single use
    expect((await request(app).get(`/invites/token/${token}`)).status).toBe(404);
    expect((await request(app).post("/invites/accept").send({ token, password: PASSWORD })).status).toBe(404);
  });

  it("VIEWERs and OPERATORs cannot manage invites or members", async () => {
    expect((await viewerAgent.get("/invites")).status).toBe(403);
    expect((await viewerAgent.post("/invites").send({ email: email("x"), role: "VIEWER" })).status).toBe(403);
    expect((await viewerAgent.get("/members")).status).toBe(200);
    const members = await viewerAgent.get("/members");
    const ownerId = members.body.members.find((m: { role: string }) => m.role === "OWNER").userId;
    expect((await viewerAgent.delete(`/members/${ownerId}`)).status).toBe(403);
  });

  it("an existing account must be signed in as the invited email", async () => {
    const addr = email("admin");
    adminAgent = request.agent(app);
    const reg = await adminAgent.post("/auth/register").send({ email: addr, password: PASSWORD, tenantName: "Admin Own Co" });
    userIds.push(reg.body.user.id);
    tenantIds.push(reg.body.tenant.id);

    const created = await owner.post("/invites").send({ email: addr, role: "ADMIN" });
    const token = tokenOf(created.body.acceptUrl);
    expect((await request(app).get(`/invites/token/${token}`)).body.accountExists).toBe(true);
    expect((await request(app).post("/invites/accept").send({ token, password: PASSWORD })).status).toBe(409);
    expect((await viewerAgent.post("/invites/accept").send({ token })).status).toBe(409); // wrong user

    const ok = await adminAgent.post("/invites/accept").send({ token });
    expect(ok.status).toBe(200);
    expect((await adminAgent.get("/auth/me")).body.activeTenantId).toBe(tenantId);
  });

  it("admins cannot invite or manage owners", async () => {
    expect((await adminAgent.post("/invites").send({ email: email("o"), role: "OWNER" })).status).toBe(403);
    const members = await adminAgent.get("/members");
    const ownerId = members.body.members.find((m: { role: string }) => m.role === "OWNER").userId;
    expect((await adminAgent.patch(`/members/${ownerId}`).send({ role: "VIEWER" })).status).toBe(403);
    const viewerId = members.body.members.find((m: { role: string }) => m.role === "VIEWER").userId;
    expect((await adminAgent.patch(`/members/${viewerId}`).send({ role: "OPERATOR" })).status).toBe(200);
  });

  it("revoked and expired invites cannot be used; re-invite replaces the old one", async () => {
    const addr = email("revoke");
    const first = await owner.post("/invites").send({ email: addr, role: "OPERATOR" });
    const second = await owner.post("/invites").send({ email: addr, role: "OPERATOR" });
    expect((await request(app).get(`/invites/token/${tokenOf(first.body.acceptUrl)}`)).status).toBe(404);

    expect((await owner.delete(`/invites/${second.body.invite.id}`)).status).toBe(204);
    expect((await request(app).get(`/invites/token/${tokenOf(second.body.acceptUrl)}`)).status).toBe(404);

    const third = await owner.post("/invites").send({ email: addr, role: "OPERATOR" });
    await prisma.invite.update({ where: { id: third.body.invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post("/invites/accept").send({ token: tokenOf(third.body.acceptUrl), password: PASSWORD })).status).toBe(404);

    const list = await owner.get("/invites");
    const states = list.body.invites.filter((i: { email: string }) => i.email === addr).map((i: { state: string }) => i.state);
    expect(states.sort()).toEqual(["expired", "revoked", "revoked"]);
  });

  it("rejects inviting an existing member and protects the last owner", async () => {
    const members = await owner.get("/members");
    const me = members.body.members.find((m: { userId: string }) => m.userId === members.body.currentUserId);
    expect((await owner.post("/invites").send({ email: me.email, role: "VIEWER" })).status).toBe(409);
    expect((await owner.patch(`/members/${me.userId}`).send({ role: "ADMIN" })).status).toBe(409);
    expect((await owner.delete(`/members/${me.userId}`)).status).toBe(409);
  });

  it("removing a member cuts off their access immediately", async () => {
    const members = await owner.get("/members");
    const viewerId = members.body.members.find((m: { role: string }) => m.role === "OPERATOR").userId;
    expect((await owner.delete(`/members/${viewerId}`)).status).toBe(204);
    expect((await viewerAgent.get("/cameras")).status).toBe(403);
  });

  it("rejects malformed tokens and cross-site requests", async () => {
    expect((await request(app).get("/invites/token/short")).status).toBe(404);
    const res = await owner.post("/invites").set("Origin", "https://evil.example").send({ email: email("csrf"), role: "VIEWER" });
    expect(res.status).toBe(403);
  });
});
