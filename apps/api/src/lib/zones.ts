import { z } from "zod";
import type { Detection } from "./detector.js";
import { hasControlChars } from "./validation.js";

export const MAX_ZONES = 8;
export const MAX_POINTS = 20;
const coord = z.number().finite().min(0).max(1);

export const zoneSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((v) => !hasControlChars(v) && !/[<>]/.test(v), "invalid characters"),
  points: z.array(z.tuple([coord, coord])).min(3).max(MAX_POINTS),
});
export const zonesSchema = z.array(zoneSchema).max(MAX_ZONES);
export type Zone = z.infer<typeof zoneSchema>;

/** Parses stored JSON defensively (bad rows count as "no zones"). */
export function parseZones(raw: unknown): Zone[] {
  const r = zonesSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The reference point of a detection: bottom-centre of its box (where a
 * person stands / a car touches the ground), which is what users mean when
 * they draw a zone on the ground (a driveway, a doorstep). */
export function anchorPoint(d: Detection): [number, number] | null {
  if (!d.box) return null;
  const [x, y, w, h] = d.box;
  return [x + w / 2, Math.min(1, y + h)];
}

/** Keeps detections whose anchor lies in any zone. No zones = keep all.
 * Detections without a box (can't be placed) are dropped when zones exist. */
export function filterDetectionsByZones(detections: Detection[], zones: Zone[]): Detection[] {
  if (zones.length === 0) return detections;
  return detections.filter((d) => {
    const p = anchorPoint(d);
    return p !== null && zones.some((z) => pointInPolygon(p[0], p[1], z.points));
  });
}

export const MASK_WIDTH = 320;
export const MASK_HEIGHT = 180;

/** Rasterises zones into a binary greyscale PGM (P5) mask: 255 inside any
 * zone, 0 outside. ffmpeg multiplies frames by it before scene scoring, so
 * movement outside the zones is invisible to motion detection. */
export function buildMaskPgm(zones: Zone[], width = MASK_WIDTH, height = MASK_HEIGHT): { pgm: Buffer; coverage: number } {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii");
  const px = Buffer.alloc(width * height);
  let on = 0;
  for (let yy = 0; yy < height; yy++) {
    const y = (yy + 0.5) / height;
    for (let xx = 0; xx < width; xx++) {
      const x = (xx + 0.5) / width;
      if (zones.some((z) => pointInPolygon(x, y, z.points))) {
        px[yy * width + xx] = 255;
        on++;
      }
    }
  }
  return { pgm: Buffer.concat([header, px]), coverage: on / (width * height) };
}

/** Scene scores are averaged over the whole frame, so a masked frame scores
 * lower in proportion to the zone's area. Scale back up so the same
 * sensitivity means the same thing with or without zones. */
export function normalizeMaskedScore(score: number, coverage: number): number {
  if (coverage >= 1) return score;
  return Math.min(1, score / Math.max(coverage, 0.02));
}
