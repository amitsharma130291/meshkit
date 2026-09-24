import { describe, expect, it } from "vitest";
import { computeStatistics, type StatisticsInput } from "./statistics";
import type { MoveSegment } from "./types";

function seg(overrides: Partial<MoveSegment> = {}): MoveSegment {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 1, y: 0, z: 0 },
    category: "extrusion",
    feature: "outer-wall",
    tool: 0,
    feedRate: 1500,
    eDelta: 0.1,
    rapid: false,
    volumetric: false,
    layerIndex: 0,
    sourceLineIndex: 0,
    temperature: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<StatisticsInput> = {}): StatisticsInput {
  return {
    fileBytes: 1000,
    decodedLines: 10,
    malformedLines: 0,
    unknownCommandLines: 0,
    checksumCounts: { valid: 0, missing: 10, mismatched: 0 },
    linearMoveLineCount: 0,
    arcLineCount: 0,
    layers: [],
    toolTemperatureSetpoints: {},
    bedTemperatureSetpoints: [],
    fanStateChanges: 0,
    segments: [],
    ...overrides,
  };
}

describe("computeStatistics — basic counts", () => {
  it("passes through file-level and line-level counters unchanged", () => {
    const stats = computeStatistics(baseInput({ fileBytes: 5000, decodedLines: 42, malformedLines: 2, unknownCommandLines: 1 }));
    expect(stats.fileBytes).toBe(5000);
    expect(stats.decodedLines).toBe(42);
    expect(stats.malformedLines).toBe(2);
    expect(stats.unknownCommandLines).toBe(1);
  });

  it("passes through checksum counts unchanged", () => {
    const stats = computeStatistics(baseInput({ checksumCounts: { valid: 5, missing: 3, mismatched: 1 } }));
    expect(stats.checksumValid).toBe(5);
    expect(stats.checksumMissing).toBe(3);
    expect(stats.checksumMismatched).toBe(1);
  });
});

describe("computeStatistics — move/segment categorization", () => {
  it("counts extrusion, travel, retract and prime segments from their category", () => {
    const segments = [
      seg({ category: "extrusion" }),
      seg({ category: "extrusion" }),
      seg({ category: "travel" }),
      seg({ category: "retract", eDelta: -0.1 }),
      seg({ category: "e-only-extrusion" }),
    ];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.extrusionMoves).toBe(3); // extrusion + e-only-extrusion
    expect(stats.travelMoves).toBe(1);
    expect(stats.retracts).toBe(1);
  });

  it("counts generated segments and distinguishes them from arc line count", () => {
    const segments = [seg(), seg(), seg(), seg(), seg()]; // 5 render segments from, say, 2 arc lines + 1 straight move
    const stats = computeStatistics(baseInput({ segments, arcLineCount: 2 }));
    expect(stats.generatedSegments).toBe(5);
    expect(stats.arcMoves).toBe(2);
  });

  it("reports the real linear-move LINE count directly, never derived by subtracting arc LINE count from total segments (a single arc line can legitimately expand into many render segments)", () => {
    // 3 real G0/G1 lines (1 segment each = 3 segments) + 1 arc line that itself expands into 31 render segments = 34 total segments.
    const segments = Array.from({ length: 34 }, () => seg());
    const stats = computeStatistics(baseInput({ segments, arcLineCount: 1, linearMoveLineCount: 3 }));
    expect(stats.generatedSegments).toBe(34);
    expect(stats.linearMoveCount).toBe(3);
  });
});

describe("computeStatistics — bounds and distances", () => {
  it("computes overall motion bounds across all segments", () => {
    const segments = [seg({ start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 1 } }), seg({ start: { x: 10, y: 5, z: 1 }, end: { x: -2, y: 8, z: 2 } })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.motionBounds).toEqual({ min: { x: -2, y: 0, z: 0 }, max: { x: 10, y: 8, z: 2 } });
  });

  it("computes extrusion-only bounds separately from overall motion bounds", () => {
    const segments = [
      seg({ category: "extrusion", start: { x: 0, y: 0, z: 0 }, end: { x: 5, y: 0, z: 0 } }),
      seg({ category: "travel", start: { x: 5, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }),
    ];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.extrusionBounds).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 0, z: 0 } });
    expect(stats.motionBounds!.max.x).toBe(100);
  });

  it("sums straight-line distance for extrusion and travel separately", () => {
    const segments = [
      seg({ category: "extrusion", start: { x: 0, y: 0, z: 0 }, end: { x: 3, y: 4, z: 0 } }), // dist 5
      seg({ category: "travel", start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 10 } }), // dist 10
    ];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.totalExtrusionDistance).toBeCloseTo(5, 6);
    expect(stats.totalTravelDistance).toBeCloseTo(10, 6);
  });

  it("sums total Z travel as the sum of absolute Z deltas across all segments", () => {
    const segments = [seg({ start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0.2 } }), seg({ start: { x: 0, y: 0, z: 0.2 }, end: { x: 0, y: 0, z: 0.1 } })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.totalZTravel).toBeCloseTo(0.3, 6);
  });
});

describe("computeStatistics — feed rate, tools, layers, extrusion by tool", () => {
  it("computes the feed rate range across all segments that carry one", () => {
    const segments = [seg({ feedRate: 1500 }), seg({ feedRate: 3000 }), seg({ feedRate: null })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.feedRateRange).toEqual({ min: 1500, max: 3000 });
  });

  it("returns a null feed rate range when no segment ever carried one", () => {
    const stats = computeStatistics(baseInput({ segments: [seg({ feedRate: null })] }));
    expect(stats.feedRateRange).toBeNull();
  });

  it("collects the distinct tool numbers used", () => {
    const segments = [seg({ tool: 0 }), seg({ tool: 1 }), seg({ tool: 0 })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.tools).toEqual([0, 1]);
  });

  it("sums raw E delta separately per tool", () => {
    const segments = [seg({ tool: 0, eDelta: 1 }), seg({ tool: 0, eDelta: 2 }), seg({ tool: 1, eDelta: 0.5 })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.rawEDeltaByTool).toEqual({ 0: 3, 1: 0.5 });
  });

  it("reports the layer count and layer-height range from the provided layer list", () => {
    const stats = computeStatistics(
      baseInput({
        layers: [
          { index: 0, z: 0.2, height: null, startLineIndex: 0, source: "inferred" },
          { index: 1, z: 0.5, height: 0.3, startLineIndex: 1, source: "inferred" },
          { index: 2, z: 0.65, height: 0.15, startLineIndex: 2, source: "inferred" },
        ],
      }),
    );
    expect(stats.layerCount).toBe(3);
    expect(stats.layerHeightRange).toEqual({ min: 0.15, max: 0.3 });
  });
});

describe("computeStatistics — nozzle temperature range (from segments, never bed)", () => {
  it("reports min/max across every segment's own known temperature", () => {
    const segments = [seg({ temperature: 200 }), seg({ temperature: 210 }), seg({ temperature: 205 })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.temperatureRange).toEqual({ min: 200, max: 210 });
  });

  it("ignores segments with an unknown (null) temperature", () => {
    const segments = [seg({ temperature: null }), seg({ temperature: 200 }), seg({ temperature: null })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.temperatureRange).toEqual({ min: 200, max: 200 });
  });

  it("is null when no segment ever had a known temperature", () => {
    const segments = [seg({ temperature: null }), seg({ temperature: null })];
    const stats = computeStatistics(baseInput({ segments }));
    expect(stats.temperatureRange).toBeNull();
  });
});

describe("computeStatistics — temperatures and fan", () => {
  it("passes through temperature setpoints and fan state change counts", () => {
    const stats = computeStatistics(baseInput({ toolTemperatureSetpoints: { 0: [200, 205] }, bedTemperatureSetpoints: [60], fanStateChanges: 3 }));
    expect(stats.toolTemperatureSetpoints).toEqual({ 0: [200, 205] });
    expect(stats.bedTemperatureSetpoints).toEqual([60]);
    expect(stats.fanStateChanges).toBe(3);
  });
});

describe("computeStatistics — never crashes on an empty file", () => {
  it("returns sane zeroed/null statistics for no segments and no lines", () => {
    const stats = computeStatistics(baseInput({ decodedLines: 0, segments: [] }));
    expect(stats.motionBounds).toBeNull();
    expect(stats.extrusionBounds).toBeNull();
    expect(stats.feedRateRange).toBeNull();
    expect(stats.layerHeightRange).toBeNull();
    expect(stats.tools).toEqual([]);
  });
});
