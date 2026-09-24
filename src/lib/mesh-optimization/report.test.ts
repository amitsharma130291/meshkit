import { describe, expect, it } from "vitest";
import { optimizeSTL } from "./optimize";
import { DEFAULT_OPTIMIZE_LIMITS } from "./types";
import { buildDownloadableOptimizeReport, STL_OPTIMIZE_REPORT_SCHEMA_VERSION } from "./report";
import { smoothSphere } from "./test-fixtures";

describe("buildDownloadableOptimizeReport", () => {
  it("includes schema version, outcome and target/achieved metrics", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1234);
    expect(report.schemaVersion).toBe(STL_OPTIMIZE_REPORT_SCHEMA_VERSION);
    expect(report.outcome).toBe("target-achieved");
    expect(report.counts.originalTriangleCount).toBeGreaterThan(report.counts.optimizedTriangleCount);
  });

  it("never includes raw geometry, output bytes, or visualization buffers", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1234);
    expect(report).not.toHaveProperty("outputBytes");
    const json = JSON.stringify(report);
    expect(json).not.toContain("Float32Array");
    expect(json).not.toContain("Uint8Array");
  });

  it("sanitizes a filename containing path separators", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "../../etc/part.stl", 1);
    expect(report.file.name).not.toContain("/");
  });

  it("includes non-empty limitations text", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("includes the sampled-deviation measurement under its own honest field name (never a 'hausdorff' key)", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1);
    expect(report.deviation).not.toBeNull();
    expect(report).not.toHaveProperty("hausdorff");
    expect(report).not.toHaveProperty("hausdorffDistance");
    // The limitations text is allowed (and expected) to mention Hausdorff
    // BY NAME specifically to disclose that this ISN'T one — that's the
    // honest disclosure this field exists to make, not a labeling bug.
    expect(report.limitations.some((l) => l.toLowerCase().includes("hausdorff") && l.toLowerCase().includes("never"))).toBe(true);
  });

  it("includes surface-area and volume comparison metrics, and the applied preset thresholds, never a stale volumeSurface field", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1234);
    expect(report).not.toHaveProperty("volumeSurface");
    expect(report.surfaceArea.before).toBeGreaterThan(0);
    expect(report.surfaceArea.after).toBeGreaterThan(0);
    expect(typeof report.surfaceArea.changePercent === "number" || report.surfaceArea.changePercent === null).toBe(true);
    expect(["completed", "not-applicable", "indeterminate"]).toContain(report.volume.status);
    expect(report.appliedThresholds.maxSurfaceAreaChangePercent).toBe(12);
    expect(report.appliedThresholds.maxVolumeChangePercent).toBe(8);
    expect(report.thresholdCheck.exceededSurfaceAreaThreshold).toBe(false);
  });
});
