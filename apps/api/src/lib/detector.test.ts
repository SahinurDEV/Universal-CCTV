import { describe, expect, it } from "vitest";
import { applyClassThresholds, decideAlert, minThreshold, parseDetections, parseRtDetr, type Detection } from "./detector.js";

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

describe("RT-DETR parsing, boxes and per-class thresholds", () => {
  it("parses logits/boxes (cx,cy,w,h) with sigmoid scores", () => {
    const C = 80;
    const logits = new Float32Array(3 * C).fill(-10);
    logits[0 * C + 0] = 3; // person ~0.95
    logits[1 * C + 5] = 0.5; // bus ~0.62
    logits[2 * C + 16] = 5; // dog (ignored)
    const boxes = new Float32Array([0.5, 0.5, 0.2, 0.4, 0.3, 0.3, 0.2, 0.2, 0.5, 0.5, 0.1, 0.1]);
    const d = parseRtDetr(logits, boxes, 3, C, 0.5);
    expect(d.map((x) => x.label)).toEqual(["person", "bus"]);
    expect(d[0]!.box).toEqual([0.4, 0.3, 0.2, 0.4]);
    expect(d[0]!.score).toBeCloseTo(0.953, 2);
  });
  it("SSD boxes are converted to x,y,w,h", () => {
    const d = parseDetections([1], [0.9], 1, 0.5, [0.2, 0.1, 0.6, 0.3]);
    expect(d[0]!.box).toEqual([0.1, 0.2, 0.2, 0.4]);
  });
  it("applies per-class thresholds with a fallback", () => {
    const ds: Detection[] = [person, car, { label: "truck", category: "vehicle", score: 0.55 }];
    expect(applyClassThresholds(ds, { person: 0.95, vehicle: 0.6 }, 0.5).map((d) => d.label)).toEqual(["car"]);
    expect(applyClassThresholds(ds, null, 0.5)).toHaveLength(3);
    expect(minThreshold({ person: 0.7 }, 0.5)).toBe(0.5);
    expect(minThreshold({ person: 0.7, vehicle: 0.8 }, 0.5)).toBe(0.7);
  });
});
