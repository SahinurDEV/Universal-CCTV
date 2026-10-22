import { describe, expect, it } from "vitest";
import { createLinkToken, createViewToken, hashLinkToken, verifyLinkToken, verifyViewToken } from "./share-tokens.js";

describe("share link tokens", () => {
  it("creates verifiable tokens and stores only a hash", () => {
    const { token, hash } = createLinkToken();
    expect(verifyLinkToken(token)).toBe(true);
    expect(hash).toBe(hashLinkToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
  it("rejects tampered or malformed tokens", () => {
    const { token } = createLinkToken();
    const flipped = token.slice(0, 5) + (token[5] === "A" ? "B" : "A") + token.slice(6);
    expect(verifyLinkToken(flipped)).toBe(false);
    expect(verifyLinkToken("sl_x.y")).toBe(false);
    expect(verifyLinkToken(token + "x")).toBe(false);
  });
  it("view tokens expire, are capped by link expiry and can't be forged", () => {
    const now = Date.now();
    const v = createViewToken("link-1", new Date(now + 60_000), now);
    expect(v.expiresAt.getTime()).toBeLessThanOrEqual(now + 60_000);
    expect(verifyViewToken(v.token, now)).toEqual({ linkId: "link-1" });
    expect(verifyViewToken(v.token, now + 61_000)).toBeNull();
    const [a, , c] = v.token.split(".");
    const forged = `${a}.${Buffer.from(JSON.stringify({ l: "other", e: 9e9 })).toString("base64url")}.${c}`;
    expect(verifyViewToken(forged, now)).toBeNull();
  });
});
