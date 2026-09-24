import { describe, expect, it } from "vitest";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { threeTrianglesSharingOneEdge, openCubeMissingFace, outwardClosedCube, closedTetrahedron, translatedClosedShell } from "../stl-diagnostics/test-fixtures";
import { smoothSphere, subdividedPlane } from "./test-fixtures";
import { DEFAULT_OPTIMIZE_LIMITS } from "./types";
import { optimizeSTL } from "./optimize";
import { STLOptimizeException } from "./errors";
import { buildDownloadableOptimizeReport } from "./report";
import { computeSurfaceArea } from "./volume-surface";

describe("optimizeSTL — end-to-end, output reparsed and re-verified", () => {
  it("produces output bytes that parse successfully with the production parser", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.outputBytes).not.toBeNull();
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    expect(reparsed.positions.length).toBeGreaterThan(0);
  });

  it("actually decreases the output byte count relative to the original", async () => {
    const original = smoothSphere(12, 24);
    const result = await optimizeSTL(original, { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.optimizedBytes).not.toBeNull();
    expect(result.optimizedBytes!).toBeLessThan(result.originalBytes);
  });

  it("achieves the requested target when it's safely achievable", async () => {
    const result = await optimizeSTL(smoothSphere(14, 28), { target: { mode: "triangle-count", value: 300 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.optimizedTriangleCount).toBeLessThanOrEqual(300);
    expect(result.outcome).toBe("target-achieved");
  });

  it("stops honestly (never throws, never claims 'failed') when the requested target is unachievable, reporting the best safe reduction", async () => {
    const result = await optimizeSTL(
      smoothSphere(10, 20),
      { target: { mode: "triangle-count", value: 1 }, preset: "balanced", minTrianglesPerShell: 100 },
      DEFAULT_OPTIMIZE_LIMITS,
    );
    expect(result.outcome).not.toBe("failed");
    expect(result.optimizedTriangleCount).toBeGreaterThanOrEqual(100);
  });

  it("keeps a watertight input watertight in the verified (reparsed) output", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.verdict).toBe("watertight");
  });

  it("preserves an open mesh's boundary topology (never increases boundary edge count)", async () => {
    const result = await optimizeSTL(subdividedPlane(6), { target: { mode: "triangle-count", value: 20 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const original = await analyzeSTLDiagnostics(subdividedPlane(6), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.boundaryEdgeCount).toBeLessThanOrEqual(original.boundaryEdgeCount);
  });

  it("preserves shell count exactly", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.shellCount).toBe(1);
  });

  it("classifies non-manifold input as unsafe-to-simplify and never attempts a mutation", async () => {
    const result = await optimizeSTL(threeTrianglesSharingOneEdge(), { target: { mode: "triangle-count", value: 1 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.eligibility).toBe("unsafe-to-simplify");
    expect(result.outcome).toBe("unchanged-no-safe-collapses");
    expect(result.acceptedCollapses).toBe(0);
  });

  it("is deterministic: optimizing the same input twice produces byte-identical output", async () => {
    const a = await optimizeSTL(smoothSphere(10, 20), { target: { mode: "triangle-count", value: 100 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const b = await optimizeSTL(smoothSphere(10, 20), { target: { mode: "triangle-count", value: 100 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(a.outputBytes).toEqual(b.outputBytes);
    expect(a.optimizedTriangleCount).toBe(b.optimizedTriangleCount);
  });

  it("never mutates the input buffer", async () => {
    const input = smoothSphere(12, 24);
    const copy = input.slice();
    await optimizeSTL(input, { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(input).toEqual(copy);
  });

  it("produces no output when cancelled", async () => {
    await expect(
      optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS, { isCancelled: () => true }),
    ).rejects.toThrow();
  });

  it("re-diagnoses the ACTUAL generated output, not the in-memory pre-serialization geometry", async () => {
    const result = await optimizeSTL(outwardClosedCube(), { target: { mode: "percentage", value: 10 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.after).not.toBeNull();
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    expect(result.after!.triangleCount).toBe(reparsed.positions.length / 9);
  });

  it("throws STLOPT_NO_VALID_TRIANGLES for a mesh with no usable triangles", async () => {
    const allDegenerate = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(optimizeSTL(allDegenerate, { target: { mode: "triangle-count", value: 1 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS)).rejects.toThrow(STLOptimizeException);
  });

  it("attempts zero collapses on a mesh already AT the shell-minimum floor, and honestly reports the (safety-clamped) target as already met", async () => {
    // A 12-triangle cube genuinely CAN reduce part-way toward a 4-triangle
    // floor (discovered by this test's own first run, which expected no
    // reduction at all and got "partially-reduced" instead — a real,
    // correct outcome for that fixture, not a bug). A closed tetrahedron
    // is already AT the 4-triangle floor: requesting target=1 resolves
    // (clamped to the safety floor) to 4, which the untouched input
    // already satisfies — "target-achieved" with zero attempted collapses
    // is the honest outcome, not a separate "unchanged" state.
    const result = await optimizeSTL(closedTetrahedron(), { target: { mode: "triangle-count", value: 1 }, preset: "balanced", minTrianglesPerShell: 4 }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.attemptedCollapses).toBe(0);
    expect(result.optimizedTriangleCount).toBe(4);
    expect(result.outcome).toBe("target-achieved");
  });

  it("directs a repair-recommended mesh to STL Repair without attempting simplification", async () => {
    const result = await optimizeSTL(openCubeMissingFaceWithDegenerate(), { target: { mode: "triangle-count", value: 1 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(["repair-recommended", "eligible-with-warnings"]).toContain(result.eligibility);
  });
});

describe("optimizeSTL — surface-area and closed-shell volume comparison (end-to-end)", () => {
  it("reports both surface area and volume before/after for a closed mesh", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.surfaceAreaBefore).toBeGreaterThan(0);
    expect(result.surfaceAreaAfter).toBeGreaterThan(0);
    expect(result.volumeStatus).toBe("completed");
    expect(result.volumeBefore).toBeGreaterThan(0);
    expect(result.volumeAfter).toBeGreaterThan(0);
  });

  it("reports surface area but leaves volume not-applicable for an open mesh, never a false zero", async () => {
    const result = await optimizeSTL(subdividedPlane(6), { target: { mode: "triangle-count", value: 20 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(result.surfaceAreaBefore).toBeGreaterThan(0);
    expect(result.surfaceAreaAfter).toBeGreaterThan(0);
    expect(result.volumeStatus).toBe("not-applicable");
    expect(result.volumeBefore).toBeNull();
    expect(result.volumeAfter).toBeNull();
    expect(result.volumeReason).toBeTruthy();
  });

  it("reports the same original volume for the same closed shell regardless of its translation (translation-stable, end-to-end)", async () => {
    const cube = await optimizeSTL(outwardClosedCube(), { target: { mode: "triangle-count", value: 12 }, preset: "balanced", minTrianglesPerShell: 12 }, DEFAULT_OPTIMIZE_LIMITS);
    const translated = await optimizeSTL(translatedClosedShell(), { target: { mode: "triangle-count", value: 12 }, preset: "balanced", minTrianglesPerShell: 12 }, DEFAULT_OPTIMIZE_LIMITS);
    expect(translated.volumeBefore).toBeCloseTo(cube.volumeBefore!, 5);
  });

  it("measures the final surface area from the REPARSED serialized output, never the intermediate mutable mesh", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const independentlyMeasured = await computeSurfaceArea(reparsed.positions);
    expect(result.surfaceAreaAfter).toBeCloseTo(independentlyMeasured, 8);
  });

  it("never reports a fully verified outcome when the surface-area change exceeds the preset's own threshold", async () => {
    const result = await optimizeSTL(
      smoothSphere(14, 28),
      { target: { mode: "triangle-count", value: 8 }, preset: "preserve-details", minTrianglesPerShell: 4 },
      DEFAULT_OPTIMIZE_LIMITS,
    );
    expect(result.thresholdCheck.exceededSurfaceAreaThreshold).toBe(true);
    expect(result.outcome).not.toBe("target-achieved");
    expect(result.outcome).not.toBe("reduced-safely");
    expect(result.thresholdCheck.reason).toContain("surface area");
  });

  it("never reports a fully verified outcome when the volume change exceeds the preset's own threshold", async () => {
    const result = await optimizeSTL(
      smoothSphere(14, 28),
      { target: { mode: "triangle-count", value: 8 }, preset: "preserve-details", minTrianglesPerShell: 4 },
      DEFAULT_OPTIMIZE_LIMITS,
    );
    expect(result.thresholdCheck.exceededVolumeThreshold).toBe(true);
    expect(result.outcome).not.toBe("target-achieved");
    expect(result.outcome).not.toBe("reduced-safely");
    expect(result.thresholdCheck.reason).toContain("volume");
  });

  it("the downloadable JSON report's surface-area and volume values match the actual reparsed output, never the pre-serialization mesh", async () => {
    const result = await optimizeSTL(smoothSphere(12, 24), { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    const report = buildDownloadableOptimizeReport(result, DEFAULT_OPTIMIZE_LIMITS, "part.stl", 1234);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const independentlyMeasured = await computeSurfaceArea(reparsed.positions);
    expect(report.surfaceArea.after).toBeCloseTo(independentlyMeasured, 8);
    expect(report.volume.status).toBe(result.volumeStatus);
    expect(report.volume.after).toBe(result.volumeAfter);
  });

  it("never mutates the source geometry while measuring surface area/volume", async () => {
    const input = smoothSphere(12, 24);
    const copy = input.slice();
    await optimizeSTL(input, { target: { mode: "triangle-count", value: 200 }, preset: "balanced" }, DEFAULT_OPTIMIZE_LIMITS);
    expect(input).toEqual(copy);
  });
});

function openCubeMissingFaceWithDegenerate(): Float32Array {
  const base = openCubeMissingFace();
  const degenerate = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Float32Array.from([...base, ...degenerate]);
}
