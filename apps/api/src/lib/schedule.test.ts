import { describe, expect, it } from "vitest";
import { alertScheduleSchema, isAlertActive, isValidTimeZone, localTime, type AlertSchedule } from "./schedule.js";

// 2026-10-22 is a Thursday.
const at = (iso: string) => new Date(iso);

describe("alert schedules", () => {
  const nights: AlertSchedule = { enabled: true, windows: [{ days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" }] };
  const office: AlertSchedule = { enabled: true, windows: [{ days: [4], start: "09:00", end: "17:30" }] };

  it("converts to the workspace timezone", () => {
    expect(localTime(at("2026-10-22T20:30:00Z"), "Asia/Dhaka")).toEqual({ day: 5, minutes: 2 * 60 + 30 });
    expect(localTime(at("2026-10-22T20:30:00Z"), "UTC")).toEqual({ day: 4, minutes: 20 * 60 + 30 });
  });

  it("same-day windows", () => {
    expect(isAlertActive(office, at("2026-10-22T03:00:00Z"), "UTC")).toBe(false);
    expect(isAlertActive(office, at("2026-10-22T10:00:00Z"), "UTC")).toBe(true);
    expect(isAlertActive(office, at("2026-10-22T17:30:00Z"), "UTC")).toBe(false); // end exclusive
    // 10:00 UTC = 16:00 Dhaka (inside); 12:00 UTC = 18:00 Dhaka (outside)
    expect(isAlertActive(office, at("2026-10-22T10:00:00Z"), "Asia/Dhaka")).toBe(true);
    expect(isAlertActive(office, at("2026-10-22T12:00:00Z"), "Asia/Dhaka")).toBe(false);
  });

  it("overnight windows continue into the next day", () => {
    expect(isAlertActive(nights, at("2026-10-22T23:00:00Z"), "UTC")).toBe(true); // Thu 23:00
    expect(isAlertActive(nights, at("2026-10-23T05:59:00Z"), "UTC")).toBe(true); // Fri 05:59 (from Thu)
    expect(isAlertActive(nights, at("2026-10-24T23:00:00Z"), "UTC")).toBe(false); // Sat night not scheduled
    expect(isAlertActive(nights, at("2026-10-25T03:00:00Z"), "UTC")).toBe(false); // Sun early (from Sat) no
    expect(isAlertActive(nights, at("2026-10-24T03:00:00Z"), "UTC")).toBe(true); // Sat early (from Fri) yes
    expect(isAlertActive(nights, at("2026-10-22T12:00:00Z"), "UTC")).toBe(false);
  });

  it("no schedule or disabled = always active", () => {
    expect(isAlertActive(null, new Date(), "UTC")).toBe(true);
    expect(isAlertActive({ ...office, enabled: false }, at("2026-10-22T03:00:00Z"), "UTC")).toBe(true);
    expect(isAlertActive({ enabled: true, windows: [] }, new Date(), "UTC")).toBe(false);
  });

  it("validation", () => {
    expect(alertScheduleSchema.safeParse({ enabled: true, windows: [{ days: [7], start: "09:00", end: "10:00" }] }).success).toBe(false);
    expect(alertScheduleSchema.safeParse({ enabled: true, windows: [{ days: [1], start: "24:00", end: "10:00" }] }).success).toBe(false);
    expect(isValidTimeZone("Asia/Dhaka")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
