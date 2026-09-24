import { describe, expect, it } from "vitest";
import { analyzeGCode, DEFAULT_ANALYZE_LIMITS } from "./analyze";
import { CancellationRequested } from "../cancellation";
import { GCodeParseException } from "./errors";
import {
  basicAbsoluteExtrusion,
  chunkString,
  checksummedLinesFixture,
  curaCommentsFixture,
  g92ResetFixture,
  helicalArcFixture,
  invalidArcFixture,
  largeCancellationFixture,
  malformedNumbersFixture,
  mixedPositioningModes,
  orcaBambuCommentsFixture,
  prusaSlicerCommentsFixture,
  relativeXYZAndExtrusion,
  twoToolFixture,
  unsupportedCommandFixture,
  variableLayerHeightsFixture,
  xyArcFixture,
  zHopFixture,
} from "./test-fixtures";

async function analyze(text: string, chunkSize = 1024, limits = DEFAULT_ANALYZE_LIMITS) {
  return analyzeGCode(chunkString(text, chunkSize), limits);
}

describe("analyzeGCode — chunked and whole-buffer parsing agree", () => {
  it("produces the same statistics regardless of chunk size", async () => {
    const text = basicAbsoluteExtrusion();
    const whole = await analyze(text, 100_000);
    const tiny = await analyze(text, 3);
    expect(tiny.statistics.generatedSegments).toBe(whole.statistics.generatedSegments);
    expect(tiny.statistics.totalExtrusionDistance).toBeCloseTo(whole.statistics.totalExtrusionDistance, 6);
    expect(tiny.render.totalSegments).toBe(whole.render.totalSegments);
  });
});

describe("analyzeGCode — modal state produces expected coordinates", () => {
  it("resolves relative XYZ and relative E correctly across a whole file", async () => {
    const result = await analyze(relativeXYZAndExtrusion());
    expect(result.statistics.extrusionMoves).toBeGreaterThan(0);
    expect(result.statistics.motionBounds).not.toBeNull();
  });

  it("G90/G91 and M82/M83 combine per the documented independent policy across a whole file", async () => {
    const result = await analyze(mixedPositioningModes());
    expect(result.status).not.toBe("failed");
    expect(result.statistics.extrusionMoves).toBeGreaterThan(0);
  });
});

describe("analyzeGCode — G92 never creates false movement", () => {
  it("a G92 reset line itself contributes no travel/extrusion distance", async () => {
    const result = await analyze(g92ResetFixture());
    // Only 2 real moves exist: G1 X10 Y10 (travel-ish, E=0) and G1 X5 Y5 E1 (extrusion). G92 must not add a third.
    expect(result.statistics.generatedSegments).toBe(2);
  });
});

describe("analyzeGCode — travel and extrusion are classified correctly", () => {
  it("a basic square print reports both travel and extrusion moves", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    expect(result.statistics.travelMoves).toBeGreaterThan(0);
    expect(result.statistics.extrusionMoves).toBeGreaterThan(0);
  });
});

describe("analyzeGCode — explicit layers override safe fallback inference", () => {
  it("uses Cura's explicit LAYER markers rather than inferring from Z", async () => {
    const result = await analyze(curaCommentsFixture());
    expect(result.layerDetectionMode).toBe("explicit");
    expect(result.layers.length).toBe(2);
  });

  it("uses PrusaSlicer's LAYER_CHANGE markers with Z:/HEIGHT: association", async () => {
    const result = await analyze(prusaSlicerCommentsFixture());
    expect(result.layerDetectionMode).toBe("explicit");
    expect(result.layers[0].z).toBe(0.2);
    expect(result.layers[1].z).toBe(0.4);
  });

  it("uses OrcaSlicer/Bambu's CHANGE_LAYER markers and FEATURE labels", async () => {
    const result = await analyze(orcaBambuCommentsFixture());
    expect(result.layerDetectionMode).toBe("explicit");
    expect(result.dialect.slicer).toBe("orcaslicer");
  });
});

describe("analyzeGCode — mixed layer detection (explicit + genuinely new trailing inferred layers)", () => {
  it("reports mode 'mixed' end-to-end when real extrusion follows the last explicit marker at a new height", async () => {
    const text = [
      ";Generated with Cura_SteamEngine 5.6.0",
      "G21",
      "G90",
      "M82",
      ";LAYER:0",
      "G1 Z0.2 F300",
      "G1 X0 Y0 F1500",
      "G1 X10 Y0 E1 F1200",
      // no further LAYER marker, but a real new-height extrusion follows
      "G1 Z0.4 F300",
      "G1 X10 Y10 E2",
      "",
    ].join("\n");
    const result = await analyze(text);
    expect(result.layerDetectionMode).toBe("mixed");
    expect(result.layers.length).toBe(2);
    expect(result.layers[0].source).toBe("explicit");
    expect(result.layers[1].source).toBe("inferred");
  });
});

describe("analyzeGCode — Z-hop does not create a layer", () => {
  it("infers exactly one layer even though Z lifts and returns mid-file", async () => {
    const result = await analyze(zHopFixture());
    expect(result.layerDetectionMode).toBe("inferred");
    expect(result.layers.length).toBe(1);
  });
});

describe("analyzeGCode — variable layer heights", () => {
  it("infers three layers with correctly varying heights", async () => {
    const result = await analyze(variableLayerHeightsFixture());
    expect(result.layers.length).toBe(3);
    expect(result.layers[1].height).toBeCloseTo(0.3, 6);
    expect(result.layers[2].height).toBeCloseTo(0.15, 6);
  });
});

describe("analyzeGCode — arc endpoints and length are correct", () => {
  it("resolves a quarter-circle arc into segments whose combined endpoints match the commanded start/end", async () => {
    const result = await analyze(xyArcFixture());
    expect(result.statistics.arcMoves).toBe(1);
    expect(result.statistics.generatedSegments).toBeGreaterThan(1); // the arc itself is subdivided into multiple segments
  });

  it("resolves a helical arc, advancing Z across its own segments", async () => {
    const result = await analyze(helicalArcFixture());
    expect(result.statistics.motionBounds!.max.z).toBeCloseTo(2, 3);
  });

  it("reports an invalid arc as a warning, never drawing it as a straight line, while still parsing the rest of the file", async () => {
    const result = await analyze(invalidArcFixture());
    expect(result.warnings.some((w) => w.toLowerCase().includes("arc"))).toBe(true);
    expect(result.status).not.toBe("failed");
    // the later valid G1 move must still have been processed
    expect(result.statistics.generatedSegments).toBeGreaterThan(0);
  });
});

describe("analyzeGCode — linear move count is never inflated by arc subdivision", () => {
  it("reports the real number of G0/G1 lines, not (total segments - arc line count) — a real bug this test was written to catch: a semicircular arc subdivides into ~31 segments, which previously made a 6-line file report 'linear moves: 6' correctly only by coincidence and silently broke for any arc producing more than 1 segment", async () => {
    const text = ["G21", "G90", "M83", "G1 X40 Y0 F1500", "G1 X40 Y40 E2", "G3 X0 Y40 I-20 J0 E4", "G1 X0 Y0 E2", ""].join("\n");
    const result = await analyze(text);
    expect(result.statistics.arcMoves).toBe(1);
    expect(result.statistics.generatedSegments).toBeGreaterThan(10); // the arc really did subdivide into many segments
    expect(result.statistics.linearMoveCount).toBe(3); // exactly the 3 real G1 lines, never generatedSegments - arcMoves
  });
});

describe("analyzeGCode — multi-tool E state remains correct", () => {
  it("tracks each tool's own E delta independently across the whole file", async () => {
    const result = await analyze(twoToolFixture());
    expect(result.statistics.tools).toEqual([0, 1]);
    expect(result.statistics.rawEDeltaByTool[0]).toBeCloseTo(2, 6);
    expect(result.statistics.rawEDeltaByTool[1]).toBeCloseTo(3, 6);
  });
});

describe("analyzeGCode — statistics match generated geometry", () => {
  it("generatedSegments in statistics equals render.totalSegments exactly", async () => {
    const result = await analyze(xyArcFixture());
    expect(result.statistics.generatedSegments).toBe(result.render.totalSegments);
  });
});

describe("analyzeGCode — render buffers have consistent lengths", () => {
  it("every per-segment typed array in a chunk has the same length as its segmentCount", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    for (const chunk of result.render.chunks) {
      expect(chunk.positions.length).toBe(chunk.segmentCount * 6);
      expect(chunk.categoryCodes.length).toBe(chunk.segmentCount);
      expect(chunk.featureCodes.length).toBe(chunk.segmentCount);
      expect(chunk.toolIndices.length).toBe(chunk.segmentCount);
      expect(chunk.feedRates.length).toBe(chunk.segmentCount);
      expect(chunk.eDeltas.length).toBe(chunk.segmentCount);
      expect(chunk.layerIndices.length).toBe(chunk.segmentCount);
      expect(chunk.cumulativeTimeSeconds.length).toBe(chunk.segmentCount);
    }
  });
});

describe("analyzeGCode — cancellation returns no stale geometry", () => {
  it("throws CancellationRequested and produces no result object when cancelled", async () => {
    const text = largeCancellationFixture(2000);
    await expect(analyzeGCode(chunkString(text, 64), DEFAULT_ANALYZE_LIMITS, { isCancelled: () => true })).rejects.toThrow(CancellationRequested);
  });
});

describe("analyzeGCode — repeated processing of the same file works", () => {
  it("produces byte-identical statistics across two independent calls", async () => {
    const text = basicAbsoluteExtrusion();
    const a = await analyze(text);
    const b = await analyze(text);
    expect(a.statistics).toEqual(b.statistics);
  });
});

describe("analyzeGCode — invalid content followed by valid processing works (no leaked state)", () => {
  it("a garbage/unsupported-heavy file never poisons a later, independent call on a valid file", async () => {
    const garbage = await analyze(unsupportedCommandFixture());
    expect(garbage.status).not.toBe("failed");
    const valid = await analyze(basicAbsoluteExtrusion());
    expect(valid.status).toBe("ready");
    expect(valid.statistics.extrusionMoves).toBeGreaterThan(0);
  });
});

describe("analyzeGCode — unsupported commands are counted, never fatal", () => {
  it("counts an unsupported G5 spline and continues parsing subsequent supported motion", async () => {
    const result = await analyze(unsupportedCommandFixture());
    expect(result.statistics.unknownCommandLines).toBeGreaterThan(0);
    expect(result.status).not.toBe("failed");
    expect(result.statistics.extrusionMoves).toBeGreaterThan(0);
  });
});

describe("analyzeGCode — malformed numbers never crash the file", () => {
  it("counts malformed lines and keeps parsing", async () => {
    const result = await analyze(malformedNumbersFixture());
    expect(result.statistics.malformedLines).toBeGreaterThan(0);
    expect(result.status).not.toBe("failed");
  });
});

describe("analyzeGCode — checksums", () => {
  it("reports valid checksum counts for a correctly checksummed file", async () => {
    const result = await analyze(checksummedLinesFixture());
    expect(result.statistics.checksumValid).toBeGreaterThan(0);
    expect(result.statistics.checksumMismatched).toBe(0);
  });
});

describe("analyzeGCode — empty file", () => {
  it("throws GCODE_EMPTY_FILE for a genuinely empty (zero-byte) file", async () => {
    await expect(analyzeGCode([], DEFAULT_ANALYZE_LIMITS)).rejects.toThrow(GCodeParseException);
  });
});

describe("analyzeGCode — active nozzle temperature propagation into render segments", () => {
  it("carries the active tool's own target temperature onto each segment, null before any is known", async () => {
    const text = ["G21", "G90", "M83", "G1 X0 Y0 F1500", "G1 X10 Y0 E1 F1200", "M104 S210", "G1 X20 Y0 E1", ""].join("\n");
    const result = await analyze(text);
    const segments = result.render.chunks[0];
    // the two moves before M104 have no known temperature yet (NaN sentinel); the move after M104 does.
    expect(Number.isNaN(segments.temperatures[0])).toBe(true);
    expect(Number.isNaN(segments.temperatures[1])).toBe(true);
    expect(segments.temperatures[2]).toBe(210);
  });

  it("reports a temperature range in statistics from valid nozzle setpoints only, never bed temperature", async () => {
    const text = ["G21", "G90", "M83", "M140 S60", "M104 S200", "G1 X10 E1 F1200", "M104 S210", "G1 X20 E1", ""].join("\n");
    const result = await analyze(text);
    expect(result.statistics.temperatureRange).toEqual({ min: 200, max: 210 });
  });

  it("reports a null temperature range when no nozzle setpoint was ever declared", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    expect(result.statistics.temperatureRange).toBeNull();
  });
});

describe("analyzeGCode — result status", () => {
  it("reports 'ready' with zero warnings for a clean, fully valid file", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    expect(result.status).toBe("ready");
    expect(result.warnings).toEqual([]);
  });

  it("reports 'ready-with-warnings' when a recoverable issue occurred (e.g. an invalid arc)", async () => {
    const result = await analyze(invalidArcFixture());
    expect(result.status).toBe("ready-with-warnings");
  });
});
