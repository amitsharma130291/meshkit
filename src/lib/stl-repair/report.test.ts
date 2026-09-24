import { describe, expect, it } from "vitest";
import { repairSTL } from "./repair";
import { DEFAULT_REPAIR_LIMITS, safePreset } from "./types";
import { buildDownloadableRepairReport, STL_REPAIR_REPORT_SCHEMA_VERSION } from "./report";
import { openCubeMissingFace } from "../stl-diagnostics/test-fixtures";

describe("buildDownloadableRepairReport", () => {
  it("includes schema version, outcome and before/after summaries", async () => {
    const result = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const report = buildDownloadableRepairReport(result, DEFAULT_REPAIR_LIMITS, "part.stl", 1234);
    expect(report.schemaVersion).toBe(STL_REPAIR_REPORT_SCHEMA_VERSION);
    expect(report.outcome).toBe("fully-repaired");
    expect(report.before.verdict).toBe("not-watertight");
    expect(report.after?.verdict).toBe("watertight");
  });

  it("never includes raw geometry, output bytes, or an overlays field", async () => {
    const result = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const report = buildDownloadableRepairReport(result, DEFAULT_REPAIR_LIMITS, "part.stl", 1234);
    expect(report).not.toHaveProperty("overlays");
    expect(report).not.toHaveProperty("outputBytes");
    const json = JSON.stringify(report);
    expect(json).not.toContain("Float32Array");
    expect(json).not.toContain("ArrayBuffer");
  });

  it("sanitizes a filename containing path separators", async () => {
    const result = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const report = buildDownloadableRepairReport(result, DEFAULT_REPAIR_LIMITS, "../../etc/part.stl", 1);
    expect(report.file.name).not.toContain("/");
  });

  it("includes non-empty limitations text", async () => {
    const result = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const report = buildDownloadableRepairReport(result, DEFAULT_REPAIR_LIMITS, "part.stl", 1);
    expect(report.limitations.length).toBeGreaterThan(0);
  });
});
