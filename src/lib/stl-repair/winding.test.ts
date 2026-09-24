import { describe, expect, it } from "vitest";
import { correctWinding } from "./winding";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { closedTetrahedron, inconsistentAdjacentWinding, inwardClosedCube, outwardClosedCube } from "../stl-diagnostics/test-fixtures";

describe("correctWinding", () => {
  it("leaves an already-consistent, already-outward mesh unchanged (zero flips)", async () => {
    const result = await correctWinding(outwardClosedCube(), { orientOutwardClosedShells: true });
    expect(result.trianglesFlipped).toBe(0);
    expect(result.shellsReversed).toBe(0);
    expect(result.unresolvedShellCount).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.windingConflictEdgeCount).toBe(0);
  });

  it("reverses a closed, consistently-wound INWARD shell to outward when requested", async () => {
    const result = await correctWinding(inwardClosedCube(), { orientOutwardClosedShells: true });
    expect(result.shellsReversed).toBe(1);
    expect(result.trianglesFlipped).toBe(12); // every triangle in a 12-triangle cube flips for a whole-shell reversal
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.inwardShellCount).toBe(0);
    expect(after.shells[0]?.orientation).toBe("outward");
  });

  it("does NOT reverse an inward shell when orientOutwardClosedShells is false, but the shell stays internally consistent", async () => {
    const result = await correctWinding(inwardClosedCube(), { orientOutwardClosedShells: false });
    expect(result.shellsReversed).toBe(0);
    expect(result.trianglesFlipped).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.inwardShellCount).toBe(1);
    expect(after.windingConflictEdgeCount).toBe(0);
  });

  it("fixes a single winding-conflict edge by flipping the one disagreeing triangle, without claiming outward orientation for an open shell", async () => {
    const before = await analyzeSTLDiagnostics(inconsistentAdjacentWinding(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(before.windingConflictEdgeCount).toBe(1);
    const result = await correctWinding(inconsistentAdjacentWinding(), { orientOutwardClosedShells: true });
    expect(result.trianglesFlipped).toBe(1);
    expect(result.unresolvedShellCount).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.windingConflictEdgeCount).toBe(0);
  });

  it("a closed tetrahedron already outward stays outward with zero flips", async () => {
    const result = await correctWinding(closedTetrahedron(), { orientOutwardClosedShells: true });
    expect(result.trianglesFlipped).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.shells[0]?.orientation).toBe("outward");
  });

  it("never mutates the input buffer", async () => {
    const input = inwardClosedCube();
    const copy = input.slice();
    await correctWinding(input, { orientOutwardClosedShells: true });
    expect(input).toEqual(copy);
  });
});
