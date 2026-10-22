import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, parseSceneScores, sensitivityToThreshold } from "./motion.js";

describe("sensitivityToThreshold", () => {
  it("maps the ends of the range", () => {
    expect(sensitivityToThreshold(1)).toBeCloseTo(0.3, 3);
    expect(sensitivityToThreshold(100)).toBeCloseTo(0.005, 3);
  });
  it("is monotonically decreasing and clamps out-of-range input", () => {
    let prev = Infinity;
    for (let s = 1; s <= 100; s++) {
      const t = sensitivityToThreshold(s);
      expect(t).toBeLessThan(prev);
      prev = t;
    }
    expect(sensitivityToThreshold(-5)).toBe(sensitivityToThreshold(1));
    expect(sensitivityToThreshold(500)).toBe(sensitivityToThreshold(100));
  });
});

describe("parseSceneScores", () => {
  it("extracts scores from ffmpeg metadata output", () => {
    const out = "frame:0 pts:0\nlavfi.scene_score=0.000000\nframe:1 pts:1\nlavfi.scene_score=0.231\nlavfi.scene_score=1\n";
    expect(parseSceneScores(out)).toEqual([0, 0.231, 1]);
  });
  it("returns an empty list for unrelated output", () => {
    expect(parseSceneScores("Connection refused")).toEqual([]);
  });
});

describe("buildFfmpegArgs", () => {
  it("passes the URL as a single argv entry and limits duration", () => {
    const args = buildFfmpegArgs("rtsp://h/x;rm -rf /", 4);
    expect(args).toContain("rtsp://h/x;rm -rf /");
    expect(args[args.indexOf("-t") + 1]).toBe("4");
  });
});
