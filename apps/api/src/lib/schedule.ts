import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");

export const scheduleWindowSchema = z.object({
  /** 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: hhmm,
  /** end ≤ start means the window runs past midnight into the next day. */
  end: hhmm,
});
export const alertScheduleSchema = z.object({
  enabled: z.boolean(),
  windows: z.array(scheduleWindowSchema).max(28),
});
export type AlertSchedule = z.infer<typeof alertScheduleSchema>;

export function parseSchedule(raw: unknown): AlertSchedule | null {
  const r = alertScheduleSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local weekday (0–6) and minutes since midnight of `date` in `timeZone`. */
export function localTime(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { day: WEEKDAYS[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** True when alerts should fire at `date`. No schedule / disabled = always. */
export function isAlertActive(schedule: AlertSchedule | null, date: Date, timeZone: string): boolean {
  if (!schedule || !schedule.enabled) return true;
  const { day, minutes } = localTime(date, timeZone);
  const yesterday = (day + 6) % 7;
  return schedule.windows.some((w) => {
    const start = toMin(w.start);
    const end = toMin(w.end);
    if (end > start) return w.days.includes(day) && minutes >= start && minutes < end;
    // Overnight window: [start, 24:00) on its day, [00:00, end) the next day.
    return (w.days.includes(day) && minutes >= start) || (w.days.includes(yesterday) && minutes < end);
  });
}
