import { describe, expect, it } from "vitest";
import { isSafeError } from "../errors";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { defaultOptimizeSettings } from "../mesh-optimization/types";
import { closedTetrahedron, outwardClosedCube, properTriangleIntersection, threeTrianglesSharingOneEdge, repeatedPositionDegeneracy } from "../stl-diagnostics/test-fixtures";
import { planOptimizeFile } from "./optimize-plan";

function stlFile(positions: Float32Array, name: string): File {
  return new File([serializeBinarySTL({ positions })], name, { type: "model/stl" });
}

describe("planOptimizeFile — real diagnostics + eligibility/target-triangle pipeline, never mutates", () => {
  it("computes an explicit target triangle count for a percentage-based target, scaled to the file's own source count", async () => {
    const settings = { ...defaultOptimizeSettings(), target: { mode: "percentage" as const, value: 50 } };
    const summary = await planOptimizeFile(stlFile(outwardClosedCube(), "cube.stl"), settings);
    expect(summary.targetTriangleCount).toBeGreaterThan(0);
    expect(summary.targetTriangleCount).toBeLessThanOrEqual(summary.sourceTriangleCount);
  });

  it("a fixed triangle-count target policy is honored directly", async () => {
    const settings = { ...defaultOptimizeSettings(), target: { mode: "triangle-count" as const, value: 4 } };
    const summary = await planOptimizeFile(stlFile(outwardClosedCube(), "cube.stl"), settings);
    expect(summary.targetTriangleCount).toBe(4);
  });

  it("classifies a mesh with non-manifold edges as unsafe-to-simplify", async () => {
    const summary = await planOptimizeFile(stlFile(threeTrianglesSharingOneEdge(), "nonmanifold.stl"), defaultOptimizeSettings());
    expect(summary.eligibility).toBe("unsafe-to-simplify");
  });

  it("classifies a mesh with self-intersections as unsafe-to-simplify", async () => {
    const summary = await planOptimizeFile(stlFile(properTriangleIntersection(), "intersecting.stl"), defaultOptimizeSettings());
    expect(summary.eligibility).toBe("unsafe-to-simplify");
  });

  it("classifies a mesh with a degenerate triangle as repair-recommended, not eligible", async () => {
    const summary = await planOptimizeFile(stlFile(repeatedPositionDegeneracy(), "degenerate.stl"), defaultOptimizeSettings());
    expect(summary.eligibility).toBe("repair-recommended");
  });

  it("classifies a clean closed mesh as eligible", async () => {
    const summary = await planOptimizeFile(stlFile(closedTetrahedron(), "tetra.stl"), defaultOptimizeSettings());
    expect(summary.eligibility).toBe("eligible");
  });

  it("exposes the selected quality preset and thresholds", async () => {
    const settings = { ...defaultOptimizeSettings(), preset: "maximum-reduction" as const };
    const summary = await planOptimizeFile(stlFile(outwardClosedCube(), "cube.stl"), settings);
    expect(summary.preset).toBe("maximum-reduction");
    expect(summary.appliedThresholds.maxSurfaceAreaChangePercent).toBeGreaterThan(0);
  });

  it("never mutates — the input file's bytes are untouched by planning", async () => {
    const file = stlFile(outwardClosedCube(), "cube.stl");
    const before = await file.arrayBuffer();
    await planOptimizeFile(file, defaultOptimizeSettings());
    const after = await file.arrayBuffer();
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });

  it("rejects with an already-safe error (never a raw parser exception) when the file isn't a valid STL", async () => {
    const invalidFile = new File([new Uint8Array([1, 2, 3, 4])], "not-an-stl.stl", { type: "model/stl" });
    let caught: unknown = null;
    try {
      await planOptimizeFile(invalidFile, defaultOptimizeSettings());
    } catch (err) {
      caught = err;
    }
    expect(isSafeError(caught)).toBe(true);
  });
});
