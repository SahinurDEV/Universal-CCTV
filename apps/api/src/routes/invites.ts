import { Router } from "express";
import { z } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { inviteCreateRateLimiter, inviteTokenRateLimiter } from "../middleware/rateLimit.js";
import { writeAuditLog } from "../lib/audit.js";
import { hashPassword } from "../lib/password.js";
import { createSession, findValidSession, setActiveTenant, SESSION_COOKIE_NAME } from "../lib/sessions.js";
import { sendMail, isMailConfigured } from "../lib/mailer.js";
import { assignableRoles, canManageMember, generateInviteToken, hashInviteToken, inviteState } from "../lib/invites.js";
import { cookieOptions, emailSchema, passwordSchema } from "./auth.js";
import { hasControlChars } from "../lib/validation.js";

/**
 * Multi-user workspaces.
 *   POST   /invites                 create (OWNER/ADMIN) → accept link
 *   GET    /invites                 list (OWNER/ADMIN)
 *   DELETE /invites/:id             revoke (OWNER/ADMIN)
 *   GET    /invites/token/:token    public preview for the accept page
 *   POST   /invites/accept          accept (signed in with the invited
 *                                   email, or create a new account)
 *   GET    /members, PATCH/DELETE /members/:userId   manage members
 */
export const invitesRouter = Router();
export const membersRouter = Router();

const ROLES = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as const;
const roleSchema = z.enum(ROLES);
const createSchema = z.object({ email: emailSchema, role: roleSchema });
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/);
const acceptSchema = z.object({
  token: tokenSchema,
  password: passwordSchema.optional(),
  displayName: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !hasControlChars(v) && !/[<>]/.test(v), "must not contain control characters or angle brackets")
    .optional(),
});

function acceptUrl(token: string) {
  return `${loadEnv().APP_PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`;
}

function serializeInvite(inv: {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  invitedBy?: { email: string } | null;
}) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    state: inviteState(inv),
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
    revokedAt: inv.revokedAt,
    createdAt: inv.createdAt,
    invitedBy: inv.invitedBy?.email ?? null,
  };
}

// ---------------------------------------------------------------- public

async function findUsableInvite(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { tenant: { select: { id: true, name: true } } },
  });
  if (!invite || inviteState(invite) !== "pending") return null;
  return invite;
}

invitesRouter.get("/token/:token", inviteTokenRateLimiter, asyncHandler(async (req, res) => {
  const token = tokenSchema.safeParse(req.params.token);
  // Invalid, expired, revoked and used tokens all look the same.
  if (!token.success) return res.status(404).json({ error: "invite_invalid" });
  const invite = await findUsableInvite(token.data);
  if (!invite) return res.status(404).json({ error: "invite_invalid" });
  const accountExists = (await prisma.user.count({ where: { email: invite.email } })) > 0;
  res.json({
    email: invite.email,
    role: invite.role,
    workspaceName: invite.tenant.name,
    expiresAt: invite.expiresAt,
    accountExists,
  });
}));

invitesRouter.post("/accept", inviteTokenRateLimiter, asyncHandler(async (req, res) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const invite = await findUsableInvite(parsed.data.token);
  if (!invite) return res.status(404).json({ error: "invite_invalid" });

  const rawSession = req.cookies?.[SESSION_COOKIE_NAME];
  const session = rawSession ? await findValidSession(rawSession) : null;
  const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });

  let userId: string;
  let newSessionToken: string | null = null;

  if (existingUser) {
    // An existing account must prove ownership by being signed in.
    if (!session || session.userId !== existingUser.id) {
      return res.status(409).json({
        error: "login_required",
        message: `Sign in as ${invite.email} first, then open the invite link again.`,
      });
    }
    userId = existingUser.id;
  } else {
    if (session) {
      return res.status(409).json({
        error: "email_mismatch",
        message: `This invite is for ${invite.email}. Sign out first to create that account.`,
      });
    }
    if (!parsed.data.password) {
      return res.status(400).json({ error: "password_required", message: "Choose a password for your new account." });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const user = await prisma.user.create({
        data: { email: invite.email, passwordHash, displayName: parsed.data.displayName || null, emailVerifiedAt: new Date() },
      });
      userId = user.id;
    } catch {
      return res.status(409).json({ error: "email_already_registered" });
    }
  }

  // Atomically consume the invite so a token can only be used once even
  // under concurrent requests.
  const consumed = await prisma.$transaction(async (tx) => {
    const marked = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (marked.count !== 1) return false;
    await tx.membership.upsert({
      where: { tenantId_userId: { tenantId: invite.tenantId, userId } },
      create: { tenantId: invite.tenantId, userId, role: invite.role },
      update: {}, // already a member: keep the existing role
    });
    return true;
  });
  if (!consumed) return res.status(404).json({ error: "invite_invalid" });

  if (session) {
    await setActiveTenant(session.id, invite.tenantId);
  } else {
    const created = await createSession(userId, invite.tenantId);
    newSessionToken = created.rawToken;
  }
  await writeAuditLog({
    tenantId: invite.tenantId,
    actorUserId: userId,
    action: "invite.accept",
    targetType: "Invite",
    targetId: invite.id,
    metadata: { role: invite.role },
  });
  if (newSessionToken) res.cookie(SESSION_COOKIE_NAME, newSessionToken, cookieOptions());
  res.json({ workspace: { id: invite.tenant.id, name: invite.tenant.name }, role: invite.role });
}));

// ---------------------------------------------------------------- admin

const adminAuth = [requireAuth, requireTenant, requireRole("OWNER", "ADMIN")];

invitesRouter.get("/", ...adminAuth, asyncHandler(async (req, res) => {
  const invites = await prisma.invite.findMany({
    where: { tenantId: req.authTenant!.id },
    include: { invitedBy: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ invites: invites.map(serializeInvite), mailConfigured: isMailConfigured() });
}));

invitesRouter.post("/", ...adminAuth, inviteCreateRateLimiter, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const { email, role } = parsed.data;
  const tenantId = req.authTenant!.id;
  if (!assignableRoles(req.authTenant!.role).includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "You cannot invite someone with that role." });
  }
  const alreadyMember = await prisma.membership.findFirst({ where: { tenantId, user: { email } } });
  if (alreadyMember) return res.status(409).json({ error: "already_member", message: "That person is already in this workspace." });

  const env = loadEnv();
  const token = generateInviteToken();
  const invite = await prisma.$transaction(async (tx) => {
    // One live invite per email per workspace: re-inviting replaces it.
    await tx.invite.updateMany({
      where: { tenantId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.invite.create({
      data: {
        tenantId,
        email,
        role,
        tokenHash: hashInviteToken(token),
        invitedById: req.authUser!.id,
        expiresAt: new Date(Date.now() + env.INVITE_TTL_HOURS * 3600 * 1000),
      },
      include: { invitedBy: { select: { email: true } }, tenant: { select: { name: true } } },
    });
  });

  const link = acceptUrl(token);
  const mail = await sendMail(
    email,
    `You're invited to ${invite.tenant.name} on Universal CCTV`,
    `${req.authUser!.email} invited you to join the "${invite.tenant.name}" workspace as ${role}.\n\n` +
      `Accept the invitation: ${link}\n\nThis link expires on ${invite.expiresAt.toUTCString()}. ` +
      `If you weren't expecting this, you can ignore this email.`,
  );
  if (!mail.sent && env.NODE_ENV === "development") {
    logger.info({ inviteId: invite.id, link }, "invite email not sent (SMTP_URL not set) — dev accept link");
  }
  await writeAuditLog({
    tenantId,
    actorUserId: req.authUser!.id,
    action: "invite.create",
    targetType: "Invite",
    targetId: invite.id,
    metadata: { role, emailSent: mail.sent },
  });
  // The link is returned once so the admin can share it manually when
  // email isn't configured; it is never retrievable again.
  res.status(201).json({ invite: serializeInvite(invite), acceptUrl: link, emailSent: mail.sent });
}));

invitesRouter.delete("/:id", ...adminAuth, asyncHandler(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const invite = await prisma.invite.findFirst({ where: { id: id.data, tenantId: req.authTenant!.id } });
  if (!invite) return res.status(404).json({ error: "not_found" });
  if (!canManageMember(req.authTenant!.role, invite.role)) return res.status(403).json({ error: "forbidden" });
  if (inviteState(invite) === "pending") {
    await prisma.invite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
    await writeAuditLog({
      tenantId: req.authTenant!.id,
      actorUserId: req.authUser!.id,
      action: "invite.revoke",
      targetType: "Invite",
      targetId: invite.id,
    });
  }
  res.status(204).send();
}));

// ---------------------------------------------------------------- members

membersRouter.use(requireAuth, requireTenant);

membersRouter.get("/", asyncHandler(async (req, res) => {
  const members = await prisma.membership.findMany({
    where: { tenantId: req.authTenant!.id },
    include: { user: { select: { id: true, email: true, displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    currentUserId: req.authUser!.id,
    currentRole: req.authTenant!.role,
    members: members.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.createdAt,
    })),
  });
}));

async function loadTarget(tenantId: string, rawUserId: string | undefined) {
  const userId = z.string().uuid().safeParse(rawUserId);
  if (!userId.success) return null;
  return prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: userId.data } } });
}

async function isLastOwner(tenantId: string, membership: { role: Role }) {
  if (membership.role !== "OWNER") return false;
  return (await prisma.membership.count({ where: { tenantId, role: "OWNER" } })) <= 1;
}

membersRouter.patch("/:userId", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsed = z.object({ role: roleSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const tenantId = req.authTenant!.id;
  const target = await loadTarget(tenantId, req.params.userId);
  if (!target) return res.status(404).json({ error: "not_found" });
  const actorRole = req.authTenant!.role;
  if (!canManageMember(actorRole, target.role) || !assignableRoles(actorRole).includes(parsed.data.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (parsed.data.role !== "OWNER" && (await isLastOwner(tenantId, target))) {
    return res.status(409).json({ error: "last_owner", message: "A workspace must keep at least one owner." });
  }
  const updated = await prisma.membership.update({ where: { id: target.id }, data: { role: parsed.data.role } });
  await writeAuditLog({
    tenantId,
    actorUserId: req.authUser!.id,
    action: "member.role_change",
    targetType: "User",
    targetId: target.userId,
    metadata: { from: target.role, to: updated.role },
  });
  res.json({ userId: target.userId, role: updated.role });
}));

membersRouter.delete("/:userId", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;
  const target = await loadTarget(tenantId, req.params.userId);
  if (!target) return res.status(404).json({ error: "not_found" });
  if (!canManageMember(req.authTenant!.role, target.role)) return res.status(403).json({ error: "forbidden" });
  if (await isLastOwner(tenantId, target)) {
    return res.status(409).json({ error: "last_owner", message: "A workspace must keep at least one owner." });
  }
  await prisma.membership.delete({ where: { id: target.id } });
  await writeAuditLog({
    tenantId,
    actorUserId: req.authUser!.id,
    action: "member.remove",
    targetType: "User",
    targetId: target.userId,
  });
  res.status(204).send();
}));
