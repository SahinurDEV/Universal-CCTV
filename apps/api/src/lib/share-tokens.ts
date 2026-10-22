import crypto from "node:crypto";
import { loadEnv } from "../env.js";

/**
 * Share-link tokens.
 *
 * Link token  = "sl_" + base64url(24 random bytes) + "." + HMAC tag.
 *   - The HMAC (key derived from APP_SECRET) lets us reject forged/garbled
 *     tokens without touching the database.
 *   - Only SHA-256(token) is stored, so a DB leak can't be turned into links.
 * View token  = short-lived (≤ 15 min) HMAC-signed grant for one link, issued
 *   after a successful open (password + view count checked). It is what the
 *   viewer uses for HLS / clip requests, and every use is re-checked against
 *   the link row (revoked/expired) too.
 */
const b64u = (b: Buffer) => b.toString("base64url");

function key(purpose: string): Buffer {
  return crypto.createHmac("sha256", loadEnv().APP_SECRET).update(`share-links:${purpose}`).digest();
}

function tag(purpose: string, data: string, len = 22): string {
  return b64u(crypto.createHmac("sha256", key(purpose)).update(data).digest()).slice(0, len);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createLinkToken(): { token: string; hash: string } {
  const body = b64u(crypto.randomBytes(24));
  const token = `sl_${body}.${tag("link", body)}`;
  return { token, hash: hashLinkToken(token) };
}

export function hashLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const LINK_RE = /^sl_([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{22})$/;

/** Signature check only (no DB). */
export function verifyLinkToken(token: string): boolean {
  const m = LINK_RE.exec(token);
  return Boolean(m && safeEqual(tag("link", m[1]!), m[2]!));
}

export const VIEW_TOKEN_TTL_SECONDS = 15 * 60;

export function createViewToken(linkId: string, linkExpiresAt: Date, now = Date.now()): { token: string; expiresAt: Date } {
  const exp = Math.min(Math.floor(now / 1000) + VIEW_TOKEN_TTL_SECONDS, Math.floor(linkExpiresAt.getTime() / 1000));
  const payload = b64u(Buffer.from(JSON.stringify({ l: linkId, e: exp })));
  return { token: `v1.${payload}.${tag("view", payload, 43)}`, expiresAt: new Date(exp * 1000) };
}

export function verifyViewToken(token: string, now = Date.now()): { linkId: string } | null {
  const m = /^v1\.([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || !safeEqual(tag("view", m[1]!, 43), m[2]!)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as { l?: unknown; e?: unknown };
    if (typeof p.l !== "string" || typeof p.e !== "number") return null;
    if (p.e * 1000 <= now) return null;
    return { linkId: p.l };
  } catch {
    return null;
  }
}
