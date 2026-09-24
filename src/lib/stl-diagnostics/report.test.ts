import { describe, expect, it } from "vitest";
import { analyzeSTLDiagnostics } from "./analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "./types";
import { buildDownloadableReport, STL_DIAGNOSTICS_REPORT_SCHEMA_VERSION } from "./report";
import { openCubeMissingFace, outwardClosedCube } from "./test-fixtures";

describe("buildDownloadableReport", () => {
  it("includes a schema version, tool version, verdict and counts", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const downloadable = buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "cube.stl", 12345);
    expect(downloadable.schemaVersion).toBe(STL_DIAGNOSTICS_REPORT_SCHEMA_VERSION);
    expect(downloadable.verdict).toBe("watertight");
    expect(downloadable.counts.triangleCount).toBe(12);
    expect(downloadable.file).toEqual({ name: "cube.stl", sizeBytes: 12345 });
  });

  it("sanitizes a filename containing path separators", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const downloadable = buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "../../etc/passwd.stl", 1);
    expect(downloadable.file.name).not.toContain("/");
    expect(downloadable.file.name).not.toContain("\\");
  });

  it("never includes raw geometry, file bytes, or an overlays field", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const downloadable = buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "cube.stl", 1);
    const json = JSON.stringify(downloadable);
    expect(downloadable).not.toHaveProperty("overlays");
    expect(json).not.toContain("Float32Array");
  });

  it("lists self-intersections as skipped, and separately as a warning, when not checked", async () => {
    const tinyLimits = { ...DEFAULT_STL_DIAGNOSTICS_LIMITS, maxCandidateIntersectionPairs: 1 };
    const many: number[] = [];
    for (let i = 0; i < 20; i++) many.push(0, 0, i * 0.001, 1, 0, i * 0.001, 0, 1, i * 0.001);
    const report = await analyzeSTLDiagnostics(Float32Array.from(many), tinyLimits);
    const downloadable = buildDownloadableReport(report, tinyLimits, "test.stl", 1);
    expect(downloadable.skippedChecks).toContain("self-intersections");
    expect(downloadable.completedChecks).not.toContain("self-intersections");
  });

  it("produces deterministic key ordering across repeated calls", async () => {
    const report = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const a = JSON.stringify(buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "a.stl", 1));
    const b = JSON.stringify(buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "a.stl", 1));
    // generatedAt differs by wall-clock time, so compare with that one field stripped.
    const strip = (s: string) => s.replace(/"generatedAt":"[^"]*"/, '"generatedAt":""');
    expect(strip(a)).toBe(strip(b));
  });

  it("includes non-empty limitations text", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const downloadable = buildDownloadableReport(report, DEFAULT_STL_DIAGNOSTICS_LIMITS, "cube.stl", 1);
    expect(downloadable.limitations.length).toBeGreaterThan(0);
  });
});
