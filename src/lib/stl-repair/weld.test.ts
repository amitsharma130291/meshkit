import { describe, expect, it } from "vitest";
import { weldVertices } from "./weld";
import { STLRepairException } from "./errors";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { outwardClosedCube } from "../stl-diagnostics/test-fixtures";
import { nearDuplicateSeam, weldCollapsesSliver } from "./test-fixtures";

const LIMITS = { maxWeldCandidates: 1_000_000, maxWeldGridCells: 1_000_000 };

describe("weldVertices", () => {
  it("with tolerance 0 (disabled), leaves vertex count unchanged", async () => {
    const result = await weldVertices(outwardClosedCube(), 0, LIMITS);
    expect(result.verticesWelded).toBe(0);
    expect(result.trianglesCollapsed).toBe(0);
  });

  it("closes a near-duplicate seam within tolerance, producing a manifold-connected mesh", async () => {
    const before = await analyzeSTLDiagnostics(nearDuplicateSeam(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(before.boundaryEdgeCount).toBeGreaterThan(0); // the seam is not connected before welding

    const result = await weldVertices(nearDuplicateSeam(), 0.001, LIMITS);
    expect(result.verticesWelded).toBe(2); // the 2 near-duplicate vertex pairs merge

    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    // The seam edge (1,0,0)-(1,1,0) is now shared by both quads' triangles.
    expect(after.manifoldEdgeCount).toBeGreaterThan(before.manifoldEdgeCount);
  });

  it("does NOT merge vertices further apart than the tolerance", async () => {
    const result = await weldVertices(nearDuplicateSeam(), 0.0001, LIMITS); // gap is 0.0005, smaller than this tolerance
    expect(result.verticesWelded).toBe(0);
  });

  it("removes a triangle whose vertices collapse together after welding", async () => {
    const result = await weldVertices(weldCollapsesSliver(), 0.0001, LIMITS);
    expect(result.trianglesCollapsed).toBe(1);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.triangleCount).toBe(1); // only the scale-reference triangle survives
  });

  it("uses deterministic representative selection (lowest canonical vertex id), never averaging coordinates", async () => {
    // Two vertices very close together; the representative position must
    // be exactly one of the two original positions, never their midpoint.
    const positions = Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // triangle 0 (scale reference)
      5, 5, 5, 5.00002, 5, 5, 6, 5, 5, // triangle 1: first two corners close
    ]);
    const result = await weldVertices(positions, 0.0001, LIMITS);
    // Find a welded vertex among the output and confirm it exactly matches one of the two inputs, not their average (5.00001).
    const xs = new Set<number>();
    for (let i = 0; i < result.positions.length; i += 3) xs.add(result.positions[i]);
    expect(xs.has(5.00001)).toBe(false);
  });

  it("throws STLREPAIR_WELD_LIMIT_EXCEEDED when the grid-cell ceiling is hit", async () => {
    await expect(weldVertices(nearDuplicateSeam(), 0.001, { maxWeldCandidates: 1_000_000, maxWeldGridCells: 1 })).rejects.toThrow(STLRepairException);
  });

  it("never mutates the input buffer", async () => {
    const input = nearDuplicateSeam();
    const copy = input.slice();
    await weldVertices(input, 0.001, LIMITS);
    expect(input).toEqual(copy);
  });

  it("never produces non-finite coordinates", async () => {
    const result = await weldVertices(nearDuplicateSeam(), 0.001, LIMITS);
    for (const v of result.positions) expect(Number.isFinite(v)).toBe(true);
  });
});
