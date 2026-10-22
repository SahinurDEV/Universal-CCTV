import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./db.js";
import { loadEnv } from "../env.js";

export const SESSION_COOKIE_NAME = "cctv_session";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a session and returns the RAW token (to set in the cookie). Only
 * the hash is persisted — the raw token is never stored or logged anywhere.
 */
export async function createSession(
  userId: string,
  activeTenantId: string | null,
  opts: { clientType?: "web" | "mobile"; deviceName?: string | null } = {},
) {
  const env = loadEnv();
  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      userId,
      activeTenantId,
      tokenHash: hashToken(rawToken),
      expiresAt,
      clientType: opts.clientType ?? "web",
      deviceName: opts.deviceName ?? null,
    },
  });

  return { rawToken, session };
}

/**
 * Looks up a session by its raw cookie token. Returns null if the token is
 * invalid, expired, or revoked — callers should treat all three identically
 * (respond 401, don't distinguish) to avoid leaking which case applied.
 */
export async function findValidSession(rawToken: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  // Best-effort activity timestamp; not awaited-critical for the request path.
  void prisma.session
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return session;
}

export async function revokeSession(rawToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function setActiveTenant(sessionId: string, tenantId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { activeTenantId: tenantId },
  });
}
