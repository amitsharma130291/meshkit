import { describe, expect, it } from "vitest";
import { analyzeSTLDiagnostics } from "./analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "./types";
import {
  branchedBoundaryWithDanglingFlap,
  closedTetrahedron,
  disconnectedShells,
  duplicateFaceReverseWinding,
  duplicateFaceSameWinding,
  inconsistentAdjacentWinding,
  inwardClosedCube,
  nearZeroAreaTriangle,
  openCubeMissingFace,
  outwardClosedCube,
  pointTouchingShells,
  properTriangleIntersection,
  repeatedPositionDegeneracy,
  singleBoundaryLoop,
  threeTrianglesSharingOneEdge,
  zeroAreaCollinearTriangle,
} from "./test-fixtures";

describe("analyzeSTLDiagnostics — end-to-end verdicts", () => {
  it("a closed, outward-wound cube is watertight", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("watertight");
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.windingConflictEdgeCount).toBe(0);
    expect(report.shellCount).toBe(1);
    expect(report.inwardShellCount).toBe(0);
    expect(report.totalEnclosedVolume).toBeCloseTo(1, 3);
    expect(report.selfIntersections.status).toBe("completed");
    expect(report.selfIntersections.intersectingPairCount).toBe(0);
  });

  it("a closed tetrahedron is watertight", async () => {
    const report = await analyzeSTLDiagnostics(closedTetrahedron(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("watertight");
  });

  it("an inward-wound closed cube is STILL watertight (topologically closed and manifold), but reported as an inward shell and flagged in slicer risk", async () => {
    const report = await analyzeSTLDiagnostics(inwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("watertight");
    expect(report.inwardShellCount).toBe(1);
    expect(report.slicerRisk.some((f) => f.code === "inward-shells")).toBe(true);
  });

  it("a cube missing one face is not-watertight due to boundary edges", async () => {
    const report = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reasonCodes).toContain("has-boundary-edges");
    expect(report.boundaryEdgeCount).toBe(4);
    expect(report.closedLoopBoundaryCount).toBe(1);
  });

  it("a single boundary loop (flat quad) is not-watertight with one closed-loop boundary component", async () => {
    const report = await analyzeSTLDiagnostics(singleBoundaryLoop(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.closedLoopBoundaryCount).toBe(1);
  });

  it("a branched boundary is reported distinctly, alongside the non-manifold edge it comes with", async () => {
    const report = await analyzeSTLDiagnostics(branchedBoundaryWithDanglingFlap(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.branchedBoundaryCount).toBe(1);
    expect(report.nonManifoldEdgeCount).toBe(1);
  });

  it("three triangles sharing one edge is not-watertight due to a non-manifold edge", async () => {
    const report = await analyzeSTLDiagnostics(threeTrianglesSharingOneEdge(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reasonCodes).toContain("has-non-manifold-edges");
    expect(report.nonManifoldEdgeCount).toBe(1);
  });

  it("inconsistent adjacent winding is not-watertight due to a winding conflict", async () => {
    const report = await analyzeSTLDiagnostics(inconsistentAdjacentWinding(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reasonCodes).toContain("has-winding-conflicts");
    expect(report.windingConflictEdgeCount).toBe(1);
  });

  it("disconnected shells are reported as 2 shells and remain watertight (each individually closed)", async () => {
    const report = await analyzeSTLDiagnostics(disconnectedShells(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.shellCount).toBe(2);
    expect(report.verdict).toBe("watertight");
    expect(report.slicerRisk.some((f) => f.code === "multiple-shells")).toBe(true);
  });

  it("point-touching shells resolve to 2 separate shells, not merged into one", async () => {
    const report = await analyzeSTLDiagnostics(pointTouchingShells(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.shellCount).toBe(2);
  });

  it("a same-winding duplicate face is not-watertight due to has-duplicate-faces", async () => {
    const report = await analyzeSTLDiagnostics(duplicateFaceSameWinding(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reasonCodes).toContain("has-duplicate-faces");
    expect(report.sameWindingDuplicateFaceCount).toBe(1);
  });

  it("a reverse-winding duplicate face is not-watertight due to has-duplicate-faces", async () => {
    const report = await analyzeSTLDiagnostics(duplicateFaceReverseWinding(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reverseWindingDuplicateFaceCount).toBe(1);
  });

  it("a repeated-position degenerate triangle is excluded from the valid mesh and reported separately", async () => {
    const report = await analyzeSTLDiagnostics(repeatedPositionDegeneracy(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.degenerateTriangleCount).toBe(1);
    expect(report.repeatedVertexTriangleCount).toBe(1);
    expect(report.validTriangleCount).toBe(1);
  });

  it("a zero-area collinear triangle is classified exact-zero-area", async () => {
    const report = await analyzeSTLDiagnostics(zeroAreaCollinearTriangle(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.exactZeroAreaTriangleCount).toBe(1);
  });

  it("a near-zero-area sliver, scaled to a large reference mesh, is classified near-zero-area", async () => {
    const report = await analyzeSTLDiagnostics(nearZeroAreaTriangle(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.nearZeroAreaTriangleCount).toBe(1);
  });

  it("a genuine self-intersecting pair makes the mesh not-watertight under the strict policy", async () => {
    const report = await analyzeSTLDiagnostics(properTriangleIntersection(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.selfIntersections.status).toBe("completed");
    expect(report.selfIntersections.intersectingPairCount).toBe(1);
    expect(report.verdict).toBe("not-watertight");
    expect(report.reasonCodes).toContain("self-intersections-found");
  });
});

describe("analyzeSTLDiagnostics — report shape", () => {
  it("includes stage timings for every named stage", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const stageNames = report.stageTimings.map((s) => s.stage);
    expect(stageNames).toEqual([
      "building-topology",
      "checking-triangles",
      "classifying-edges",
      "finding-boundary-components",
      "resolving-shells",
      "checking-orientation",
      "building-spatial-index",
      "checking-intersections",
      "preparing-report",
    ]);
  });

  it("produces bounded overlay buffers with a boundary edge line for an open mesh", async () => {
    const report = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.overlays.boundaryEdgeLines.length).toBe(4 * 6); // 4 boundary edges * 2 endpoints * 3 floats
    expect(report.overlays.truncated.boundaryEdgeLines).toBe(false);
  });

  it("produces a per-shell overlay buffer keyed by shell id", async () => {
    const report = await analyzeSTLDiagnostics(disconnectedShells(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(Object.keys(report.overlays.shellPositionsById)).toHaveLength(2);
    expect(report.overlays.shellPositionsById[0].length).toBeGreaterThan(0);
    expect(report.overlays.shellPositionsById[1].length).toBeGreaterThan(0);
  });

  it("reports honest, calibrated shell summaries including bounds and surface area", async () => {
    const report = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(report.shells).toHaveLength(1);
    expect(report.shells[0].triangleCount).toBe(12);
    expect(report.shells[0].surfaceArea).toBeCloseTo(6, 3); // unit cube surface area
    expect(report.shells[0].closed).toBe(true);
  });
});

describe("analyzeSTLDiagnostics — determinism", () => {
  it("produces identical verdicts and counts across repeated runs on the same input", async () => {
    const positions = branchedBoundaryWithDanglingFlap();
    const a = await analyzeSTLDiagnostics(positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const b = await analyzeSTLDiagnostics(positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const strip = (report: typeof a) => {
      const { stageTimings, ...rest } = report;
      void stageTimings; // wall-clock timing is expected to vary run to run
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
  });
});

describe("analyzeSTLDiagnostics — cancellation and safety ceilings", () => {
  it("stops early and never returns a result when cancelled", async () => {
    await expect(
      analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS, { isCancelled: () => true }),
    ).rejects.toThrow();
  });

  it("reports self-intersections as not-checked, never as passing, when the candidate-pair ceiling is hit", async () => {
    const tinyLimits = { ...DEFAULT_STL_DIAGNOSTICS_LIMITS, maxCandidateIntersectionPairs: 1 };
    // Many coincident-bbox triangles force many broad-phase candidate pairs.
    const many: number[] = [];
    for (let i = 0; i < 20; i++) many.push(0, 0, i * 0.001, 1, 0, i * 0.001, 0, 1, i * 0.001);
    const report = await analyzeSTLDiagnostics(Float32Array.from(many), tinyLimits);
    expect(report.selfIntersections.status).toBe("not-checked");
    expect(report.warnings.some((w) => w.code.startsWith("self-intersections-skipped"))).toBe(true);
    // Never silently claims a pass when the check was skipped.
    expect(report.reasonCodes).not.toContain("all-checks-passed");
  });

  it("throws a budget error rather than hanging when the analysis budget is already exceeded before core stages run", async () => {
    const impossibleLimits = { ...DEFAULT_STL_DIAGNOSTICS_LIMITS, maxAnalysisMs: -1 };
    await expect(analyzeSTLDiagnostics(outwardClosedCube(), impossibleLimits)).rejects.toThrow();
  });
});
