import { describe, expect, it } from "vitest";
import { anchorPoint, buildMaskPgm, filterDetectionsByZones, normalizeMaskedScore, parseZones, pointInPolygon, zonesSchema, type Zone } from "./zones.js";
import type { Detection } from "./detector.js";

const leftHalf: Zone = { id: "z1", name: "Left", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] };
const tri: [number, number][] = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]];

describe("zones", () => {
  it("point in polygon (convex + concave)", () => {
    expect(pointInPolygon(0.5, 0.3, tri)).toBe(true);
    expect(pointInPolygon(0.1, 0.8, tri)).toBe(false);
    const u: [number, number][] = [[0, 0], [1, 0], [1, 1], [0.66, 1], [0.66, 0.3], [0.33, 0.3], [0.33, 1], [0, 1]];
    expect(pointInPolygon(0.5, 0.8, u)).toBe(false);
    expect(pointInPolygon(0.1, 0.8, u)).toBe(true);
  });

  it("filters detections by their bottom-centre anchor", () => {
    const inLeft: Detection = { label: "person", category: "person", score: 0.9, box: [0.1, 0.2, 0.2, 0.5] };
    const inRight: Detection = { label: "car", category: "vehicle", score: 0.8, box: [0.6, 0.5, 0.3, 0.3] };
    const noBox: Detection = { label: "person", category: "person", score: 0.9 };
    expect(anchorPoint(inLeft)).toEqual([0.2, 0.7]);
    expect(filterDetectionsByZones([inLeft, inRight, noBox], [leftHalf])).toEqual([inLeft]);
    expect(filterDetectionsByZones([inLeft, inRight, noBox], [])).toHaveLength(3);
  });

  it("validates zone input strictly", () => {
    expect(zonesSchema.safeParse([leftHalf]).success).toBe(true);
    expect(zonesSchema.safeParse([{ ...leftHalf, points: [[0, 0], [1, 1]] }]).success).toBe(false);
    expect(zonesSchema.safeParse([{ ...leftHalf, points: [[0, 0], [1.2, 1], [0, 1]] }]).success).toBe(false);
    expect(zonesSchema.safeParse([{ ...leftHalf, name: "<script>" }]).success).toBe(false);
    expect(zonesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ ...leftHalf, id: `z${i}` }))).success).toBe(false);
    expect(parseZones("garbage")).toEqual([]);
  });

  it("builds a PGM mask with the right coverage", () => {
    const { pgm, coverage } = buildMaskPgm([leftHalf], 32, 18);
    expect(pgm.subarray(0, 12).toString()).toBe("P5\n32 18\n255\n".slice(0, 12));
    expect(coverage).toBeCloseTo(0.5, 2);
    const header = Buffer.from("P5\n32 18\n255\n").length;
    expect(pgm[header]).toBe(255); // top-left pixel inside
    expect(pgm[header + 31]).toBe(0); // top-right outside
  });

  it("normalises masked scene scores by coverage", () => {
    expect(normalizeMaskedScore(0.01, 0.25)).toBeCloseTo(0.04);
    expect(normalizeMaskedScore(0.5, 0.01)).toBe(1);
    expect(normalizeMaskedScore(0.03, 1)).toBe(0.03);
  });
});
