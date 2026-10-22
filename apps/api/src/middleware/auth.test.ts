import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { extractSessionToken } from "./auth.js";

const tok = "ab".repeat(32);
const req = (headers: Record<string, string>, cookies: Record<string, string> = {}) => ({ headers, cookies }) as unknown as Request;

describe("extractSessionToken", () => {
  it("prefers a well-formed bearer token (mobile channel)", () => {
    expect(extractSessionToken(req({ authorization: `Bearer ${tok}` }, { cctv_session: "c" }))).toEqual({ token: tok, channel: "mobile" });
  });
  it("uses the cookie when no Authorization header (web channel)", () => {
    expect(extractSessionToken(req({}, { cctv_session: tok }))).toEqual({ token: tok, channel: "web" });
  });
  it("rejects malformed Authorization headers instead of falling back", () => {
    for (const h of ["Bearer", `Bearer ${tok}x`, `bearer ${tok}`, `Basic ${tok}`, `Bearer ${tok.toUpperCase()}`]) {
      expect(extractSessionToken(req({ authorization: h }, { cctv_session: tok }))).toBe("invalid");
    }
  });
  it("returns null with no credentials", () => {
    expect(extractSessionToken(req({}))).toBeNull();
  });
});
