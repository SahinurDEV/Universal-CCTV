import { describe, expect, it } from "vitest";
import { effectiveRetentionDays } from "./retention.js";

describe("effectiveRetentionDays", () => {
  it("camera override wins, then workspace, else null", () => {
    expect(effectiveRetentionDays(7, 30)).toBe(7);
    expect(effectiveRetentionDays(null, 30)).toBe(30);
    expect(effectiveRetentionDays(undefined, null)).toBeNull();
  });
});
