import { describe, expect, it } from "vitest";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import {
  duplicateFaceSameWinding,
  openCubeMissingFace,
  outwardClosedCube,
  properTriangleIntersection,
  repeatedPositionDegeneracy,
  threeTrianglesSharingOneEdge,
} from "../stl-diagnostics/test-fixtures";
import { classifyEligibility, planOptimize } from "./plan";

async function analyze(positions: Float32Array) {
  return analyzeSTLDiagnostics(positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
}

describe("classifyEligibility", () => {
  it("classifies a watertight manifold mesh as eligible", async () => {
    const result = classifyEligibility(await analyze(outwardClosedCube()));
    expect(result.eligibility).toBe("eligible");
  });

  it("classifies an open manifold mesh as eligible-with-warnings (boundary-preservation constraints apply)", async () => {
    const result = classifyEligibility(await analyze(openCubeMissingFace()));
    expect(result.eligibility).toBe("eligible-with-warnings");
    expect(result.reasons.some((r) => r.toLowerCase().includes("boundary"))).toBe(true);
  });

  it("classifies duplicate-face geometry (isolated, no resulting non-manifold edges) as repair-recommended", async () => {
    // Two exact, isolated coincident flat triangles: each of their 3 shared
    // edges has exactly 2 incident triangle-uses (manifold by this
    // codebase's own count-based definition), so this case is purely a
    // duplicate-face finding — unlike `duplicateFaceSameWinding()`'s own
    // closed-tetrahedron-plus-duplicate fixture, which this test suite's
    // own next case discovered ALSO creates non-manifold edges (adding a
    // duplicate face to an already-closed shell structurally pushes that
    // face's edges to 3 incident triangles), making that fixture a
    // genuine unsafe-to-simplify case instead, correctly taking
    // precedence — this fixture isolates the duplicate-only scenario.
    const isolated = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const result = classifyEligibility(await analyze(isolated));
    expect(result.eligibility).toBe("repair-recommended");
  });

  it("classifies duplicate-face geometry on an already-closed shell as unsafe-to-simplify (non-manifold takes precedence)", async () => {
    // Discovered while writing the test above: duplicateFaceSameWinding()'s
    // own fixture (a closed tetrahedron plus one duplicated face) also
    // creates non-manifold edges on that face's boundary as a direct
    // structural consequence — the more severe classification correctly wins.
    const report = await analyze(duplicateFaceSameWinding());
    expect(report.nonManifoldEdgeCount).toBeGreaterThan(0);
    const result = classifyEligibility(report);
    expect(result.eligibility).toBe("unsafe-to-simplify");
  });

  it("classifies degenerate-triangle geometry as repair-recommended", async () => {
    const result = classifyEligibility(await analyze(repeatedPositionDegeneracy()));
    expect(result.eligibility).toBe("repair-recommended");
  });

  it("classifies non-manifold topology as unsafe-to-simplify by default", async () => {
    const result = classifyEligibility(await analyze(threeTrianglesSharingOneEdge()));
    expect(result.eligibility).toBe("unsafe-to-simplify");
  });

  it("classifies a mesh with a confirmed, unresolved self-intersection as unsafe-to-simplify", async () => {
    const result = classifyEligibility(await analyze(properTriangleIntersection()));
    expect(result.eligibility).toBe("unsafe-to-simplify");
  });

  it("non-manifold topology takes precedence over a merely-open boundary (most severe finding wins)", async () => {
    // threeTrianglesSharingOneEdge also has boundary edges — non-manifold must still win.
    const report = await analyze(threeTrianglesSharingOneEdge());
    expect(report.boundaryEdgeCount).toBeGreaterThan(0);
    expect(report.nonManifoldEdgeCount).toBeGreaterThan(0);
    const result = classifyEligibility(report);
    expect(result.eligibility).toBe("unsafe-to-simplify");
  });
});

describe("planOptimize", () => {
  it("never mutates anything — pure preview of eligibility and the resolved target", async () => {
    const report = await analyze(outwardClosedCube());
    const plan = planOptimize(report, { target: { mode: "triangle-count", value: 4 }, preset: "balanced" }, 4);
    expect(plan.eligibility).toBe("eligible");
    expect(plan.requestedTargetTriangleCount).toBe(4);
    expect(plan.before.triangleCount).toBe(report.triangleCount);
  });

  it("clamps the previewed target to the safety floor, same as the real pipeline resolves it", async () => {
    const report = await analyze(outwardClosedCube());
    const plan = planOptimize(report, { target: { mode: "triangle-count", value: 1 }, preset: "balanced" }, 4);
    expect(plan.requestedTargetTriangleCount).toBe(4);
  });

  it("surfaces the preset's own surface-area/volume quality-policy thresholds in the plan, so they're visible before anything runs", async () => {
    const report = await analyze(outwardClosedCube());
    const plan = planOptimize(report, { target: { mode: "triangle-count", value: 4 }, preset: "preserve-details" }, 4);
    expect(plan.appliedThresholds).toEqual({ maxSurfaceAreaChangePercent: 3, maxVolumeChangePercent: 2 });
  });

  it("resolves the correct thresholds per preset", async () => {
    const report = await analyze(outwardClosedCube());
    const plan = planOptimize(report, { target: { mode: "triangle-count", value: 4 }, preset: "maximum-reduction" }, 4);
    expect(plan.appliedThresholds).toEqual({ maxSurfaceAreaChangePercent: 35, maxVolumeChangePercent: 25 });
  });
});
