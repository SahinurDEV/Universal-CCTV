import { describe, expect, it } from "vitest";
import { decideAlert, parseDetections, type Detection } from "./detector.js";

describe("parseDetections", () => {
  it("keeps person/vehicle classes above the score, sorted", () => {
    const classes = [3, 1, 6, 17, 1, 8];
    const scores = [0.6, 0.97, 0.82, 0.9, 0.3, 0.55];
    const d = parseDetections(classes, scores, 6, 0.5);
    expect(d.map((x) => x.label)).toEqual(["person", "bus", "car", "truck"]);
    expect(d[0]).toMatchObject({ category: "person" });
    expect(d.find((x) => x.label === "bus")?.category).toBe("vehicle");
  });
  it("respects num_detections and ignores NaN", () => {
    expect(parseDetections([1, 1], [0.9, 0.9], 1, 0.5)).toHaveLength(1);
    expect(parseDetections([1], [Number.NaN], 1, 0.5)).toHaveLength(0);
  });
});

const person: Detection = { label: "person", category: "person", score: 0.9 };
const car: Detection = { label: "car", category: "vehicle", score: 0.8 };

describe("decideAlert", () => {
  it("falls back to a plain motion alert when the detector is unavailable", () => {
    expect(decideAlert(["person"], null)).toMatchObject({ alert: true, type: "MOTION_DETECTED" });
  });
  it("'any' alerts on everything, typed by what was seen", () => {
    expect(decideAlert(["any"], [])).toMatchObject({ alert: true, type: "MOTION_DETECTED" });
    expect(decideAlert(["any"], [car])).toMatchObject({ alert: true, type: "VEHICLE_DETECTED" });
    expect(decideAlert(["any"], [car, person])).toMatchObject({ alert: true, type: "PERSON_DETECTED" });
  });
  it("only alerts for selected classes", () => {
    expect(decideAlert(["person"], [car])).toEqual({ alert: false });
    expect(decideAlert(["person"], [])).toEqual({ alert: false });
    expect(decideAlert(["vehicle"], [car])).toMatchObject({ type: "VEHICLE_DETECTED" });
    expect(decideAlert(["person", "vehicle"], [person, person, car])).toMatchObject({
      type: "PERSON_DETECTED",
      summary: "Person detected (2× person, car)",
    });
  });
});
