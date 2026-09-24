import { describe, expect, it } from "vitest";
import { analyzeGCode, DEFAULT_ANALYZE_LIMITS } from "./analyze";
import { buildDownloadableGCodeReport, GCODE_REPORT_SCHEMA_VERSION } from "./report";
import { basicAbsoluteExtrusion, chunkString, curaCommentsFixture } from "./test-fixtures";

async function analyze(text: string) {
  return analyzeGCode(chunkString(text, 4096), DEFAULT_ANALYZE_LIMITS);
}

describe("buildDownloadableGCodeReport", () => {
  it("includes schema version, parser scope, and dialect inference", async () => {
    const result = await analyze(curaCommentsFixture());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1234);
    expect(report.schemaVersion).toBe(GCODE_REPORT_SCHEMA_VERSION);
    expect(report.parserScope).toContain("FDM");
    expect(report.dialect.slicer).toBe("cura");
  });

  it("includes layer, movement, tool, and bounds information", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1234);
    expect(report.layers.count).toBeGreaterThan(0);
    expect(report.movement.extrusionMoves).toBeGreaterThan(0);
    expect(report.bounds.motion).not.toBeNull();
  });

  it("includes temperature statistics and dialect confidence", async () => {
    const text = ["G21", "G90", "M83", "M104 S210", "G1 X10 E1 F1200", ""].join("\n");
    const result = await analyze(text);
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1234);
    expect(report.tools.temperatureRange).toEqual({ min: 210, max: 210 });
    expect(report.dialect.confidence).toBeDefined();
  });

  it("includes time estimates with their sources kept separate", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1234);
    expect(report.timeEstimates.feedRateOnlySource).toBe("feed-rate-only estimate");
    expect(report.timeEstimates.slicerProvidedSeconds).toBeNull();
  });

  it("never includes full raw G-code, arbitrary full comments, local paths, source bytes, or a stack trace", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1234);
    const json = JSON.stringify(report);
    expect(json).not.toContain("G1 X10");
    expect(json).not.toContain("stack");
    expect(report).not.toHaveProperty("render");
    expect(report).not.toHaveProperty("rawText");
  });

  it("sanitizes a filename containing path separators", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "../../etc/part.gcode", 1);
    expect(report.file.name).not.toContain("/");
  });

  it("includes non-empty limitations text", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("includes safety-limit status honestly reflecting whether the file was fully processed", async () => {
    const result = await analyze(basicAbsoluteExtrusion());
    const report = buildDownloadableGCodeReport(result, "part.gcode", 1);
    expect(report.safetyLimitStatus).toBe("not-limited");
  });
});
