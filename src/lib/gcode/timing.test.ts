import { describe, expect, it } from "vitest";
import { computeFeedRateOnlyEstimateSeconds, computeSegmentDurationSeconds, parseDwellSeconds, buildTimingEstimate } from "./timing";
import { tokenizeLine } from "./tokenizer";
import type { MoveSegment } from "./types";

function seg(distance: number, feedRate: number | null): MoveSegment {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: distance, y: 0, z: 0 },
    category: "extrusion",
    feature: "outer-wall",
    tool: 0,
    feedRate,
    eDelta: 0.1,
    rapid: false,
    volumetric: false,
    layerIndex: 0,
    sourceLineIndex: 0,
    temperature: null,
  };
}

describe("computeFeedRateOnlyEstimateSeconds", () => {
  it("computes distance / feed rate for a single segment, converted to seconds", () => {
    // 60mm at 60mm/min = 1 minute = 60 seconds.
    const seconds = computeFeedRateOnlyEstimateSeconds([seg(60, 60)], 0);
    expect(seconds).toBeCloseTo(60, 6);
  });

  it("sums across multiple segments", () => {
    const seconds = computeFeedRateOnlyEstimateSeconds([seg(60, 60), seg(120, 60)], 0);
    expect(seconds).toBeCloseTo(180, 6);
  });

  it("adds explicit dwell time on top of the moving-time estimate", () => {
    const seconds = computeFeedRateOnlyEstimateSeconds([seg(60, 60)], 5);
    expect(seconds).toBeCloseTo(65, 6);
  });

  it("skips a segment with no feed rate rather than crashing or dividing by zero", () => {
    expect(() => computeFeedRateOnlyEstimateSeconds([seg(60, null)], 0)).not.toThrow();
    expect(computeFeedRateOnlyEstimateSeconds([seg(60, null)], 0)).toBe(0);
  });

  it("is deterministic", () => {
    const segments = [seg(30, 1500), seg(45, 3000)];
    expect(computeFeedRateOnlyEstimateSeconds(segments, 1)).toBe(computeFeedRateOnlyEstimateSeconds(segments, 1));
  });
});

describe("computeSegmentDurationSeconds — the shared per-segment helper computeFeedRateOnlyEstimateSeconds sums", () => {
  it("computes one segment's own duration in seconds", () => {
    expect(computeSegmentDurationSeconds(seg(60, 60))).toBeCloseTo(60, 6);
  });

  it("returns 0 for a segment with no feed rate", () => {
    expect(computeSegmentDurationSeconds(seg(60, null))).toBe(0);
  });

  it("summing per-segment durations matches the bulk estimate", () => {
    const segments = [seg(60, 60), seg(120, 60)];
    const summed = segments.reduce((acc, s) => acc + computeSegmentDurationSeconds(s), 0);
    expect(summed).toBeCloseTo(computeFeedRateOnlyEstimateSeconds(segments, 0), 6);
  });
});

describe("parseDwellSeconds — G4", () => {
  it("parses P (milliseconds) into seconds", () => {
    expect(parseDwellSeconds(tokenizeLine("G4 P1500"))).toBeCloseTo(1.5, 6);
  });

  it("parses S (seconds) directly", () => {
    expect(parseDwellSeconds(tokenizeLine("G4 S2"))).toBe(2);
  });

  it("returns 0 for a G4 line with neither P nor S", () => {
    expect(parseDwellSeconds(tokenizeLine("G4"))).toBe(0);
  });

  it("returns 0 for a non-dwell line", () => {
    expect(parseDwellSeconds(tokenizeLine("G1 X10"))).toBe(0);
  });
});

describe("buildTimingEstimate — keeps sources separate", () => {
  it("carries the slicer-provided estimate and the computed feed-rate-only estimate as distinct, separately labelled fields", () => {
    const estimate = buildTimingEstimate({ slicerProvidedSeconds: 3600, segments: [seg(60, 60)], dwellSeconds: 0 });
    expect(estimate.slicerProvidedSeconds).toBe(3600);
    expect(estimate.feedRateOnlySeconds).toBeCloseTo(60, 6);
  });

  it("never invents a slicer-provided estimate when none was found in comments", () => {
    const estimate = buildTimingEstimate({ slicerProvidedSeconds: null, segments: [], dwellSeconds: 0 });
    expect(estimate.slicerProvidedSeconds).toBeNull();
  });

  it("labels the computed estimate honestly as feed-rate-only, never as actual print time", () => {
    const estimate = buildTimingEstimate({ slicerProvidedSeconds: null, segments: [seg(60, 60)], dwellSeconds: 0 });
    expect(estimate.feedRateOnlySource).toBe("feed-rate-only estimate");
  });
});
