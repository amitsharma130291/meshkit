import { describe, expect, it } from "vitest";
import { removeSmallShells } from "./shell-cleanup";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { disconnectedShells, outwardClosedCube } from "../stl-diagnostics/test-fixtures";
import { largeCubeWithSmallDetachedTetrahedron } from "./test-fixtures";

const BASE = { maxShellsConsidered: 10_000 };

describe("removeSmallShells", () => {
  it("removes the small tetrahedron by triangle-count threshold, keeping the cube", async () => {
    const result = await removeSmallShells(largeCubeWithSmallDetachedTetrahedron(), { ...BASE, criterion: "triangle-count", threshold: 4 });
    expect(result.shellsRemoved).toHaveLength(1);
    expect(result.shellsRemoved[0].triangleCount).toBe(4);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.shellCount).toBe(1);
    expect(after.triangleCount).toBe(12);
  });

  it("removes the small tetrahedron by relative-area threshold", async () => {
    const result = await removeSmallShells(largeCubeWithSmallDetachedTetrahedron(), { ...BASE, criterion: "relative-area", threshold: 0.05 });
    expect(result.shellsRemoved).toHaveLength(1);
  });

  it("removes the small tetrahedron by absolute-diagonal threshold", async () => {
    const result = await removeSmallShells(largeCubeWithSmallDetachedTetrahedron(), { ...BASE, criterion: "absolute-diagonal", threshold: 0.5 });
    expect(result.shellsRemoved).toHaveLength(1);
  });

  it("never removes every shell, even when the threshold nominally matches all of them", async () => {
    const result = await removeSmallShells(disconnectedShells(), { ...BASE, criterion: "triangle-count", threshold: 1000 });
    expect(result.shellsRemoved.length).toBeLessThan(result.shellCountBefore);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.shellCount).toBeGreaterThanOrEqual(1);
  });

  it("removes nothing when no shell qualifies as small", async () => {
    const result = await removeSmallShells(outwardClosedCube(), { ...BASE, criterion: "triangle-count", threshold: 0 });
    expect(result.shellsRemoved).toHaveLength(0);
  });

  it("never mutates the input buffer", async () => {
    const input = largeCubeWithSmallDetachedTetrahedron();
    const copy = input.slice();
    await removeSmallShells(input, { ...BASE, criterion: "triangle-count", threshold: 4 });
    expect(input).toEqual(copy);
  });
});
