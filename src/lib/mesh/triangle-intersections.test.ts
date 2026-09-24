import { describe, expect, it } from "vitest";
import { trianglesIntersect, analyzeSelfIntersections, type TrianglePositions } from "./triangle-intersections";
import { buildCanonicalMesh } from "./canonical-vertices";
import { buildEdgeIncidence } from "./edge-incidence";
import { analyzeDuplicateFaces } from "./duplicate-faces";
import {
  adjacentSharedEdgeTriangles,
  closedTetrahedron,
  duplicateFaceSameWinding,
  nonAdjacentCoplanarOverlap,
  outwardClosedCube,
  properTriangleIntersection,
  sharedVertexOnlyTriangles,
} from "../stl-diagnostics/test-fixtures";

const EPS = 1e-6;

function t(a: [number, number, number], b: [number, number, number], c: [number, number, number]): TrianglePositions {
  return { a, b, c };
}

describe("trianglesIntersect — narrow phase", () => {
  it("detects a proper interior crossing", () => {
    const t1 = t([-1, -1, 0], [1, -1, 0], [0, 1, 0]);
    const t2 = t([0, 0, -1], [0, 0, 1], [0.5, -0.5, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(true);
  });

  it("does not flag two triangles that only touch at a shared vertex", () => {
    const shared: [number, number, number] = [0, 0, 0];
    const t1 = t(shared, [1, 0, 0], [0, 1, 0]);
    const t2 = t(shared, [-1, 0, 0], [0, -1, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(false);
  });

  it("detects genuine crossing even when the two triangles also share a vertex", () => {
    const shared: [number, number, number] = [0, 0, 0];
    const t1 = t(shared, [2, 0, 0], [0, 2, 0]); // in z=0 plane
    const t2 = t([1, -1, -1], [1, -1, 1], [1, 1, 0]); // pierces through t1's interior near (1, 0-ish, 0)
    expect(trianglesIntersect(t1, t2, EPS)).toBe(true);
  });

  it("does not flag two coplanar triangles that merely share an edge", () => {
    const t1 = t([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const t2 = t([1, 0, 0], [1, 1, 0], [0, 1, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(false);
  });

  it("detects non-adjacent coplanar overlap (same plane, overlapping area, no shared vertex/edge)", () => {
    const t1 = t([0, 0, 0], [4, 0, 0], [0, 4, 0]);
    const t2 = t([1, 1, 0], [5, 1, 0], [1, 5, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(true);
  });

  it("does not flag two coplanar triangles that are merely adjacent without overlapping (side by side)", () => {
    const t1 = t([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const t2 = t([2, 0, 0], [3, 0, 0], [2, 1, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(false);
  });

  it("does not flag two triangles on parallel, non-coplanar planes (no contact at all)", () => {
    const base = t([0, 0, 0], [2, 0, 0], [0, 2, 0]);
    const above = t([0, 0, 1], [2, 0, 1], [0, 2, 1]);
    expect(trianglesIntersect(base, above, EPS)).toBe(false);
  });

  it("does not flag a triangle whose single vertex merely grazes another triangle's plane from one side (touching, not crossing)", () => {
    const base = t([0, 0, 0], [2, 0, 0], [0, 2, 0]); // in z=0 plane
    const touching = t([0.5, 0.5, 0], [0.5, 0.5, 1], [1.5, 0.5, 1]); // one vertex exactly on the plane, the other two strictly above it
    expect(trianglesIntersect(base, touching, EPS)).toBe(false);
  });

  it("detects an exact duplicate (identical, fully overlapping) triangle pair", () => {
    const t1 = t([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const t2 = t([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(trianglesIntersect(t1, t2, EPS)).toBe(true);
  });
});

describe("analyzeSelfIntersections — orchestration", () => {
  const LIMITS = { targetTrianglesPerCell: 4, maxGridCells: 100_000, maxCandidatePairs: 100_000, maxSamplePairs: 50 };

  async function analyze(positions: Float32Array) {
    const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: 1_000_000 });
    const inc = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: 1_000_000 });
    const dup = analyzeDuplicateFaces(mesh.validTriangles, { maxGroups: 1000, maxTriangleIndicesPerGroup: 100 });
    return analyzeSelfIntersections(mesh.validTriangles, mesh.vertices, inc.edgesByKey, dup.groups, mesh.bounds, LIMITS);
  }

  it("a closed cube (only expected manifold adjacency) reports zero self-intersections", async () => {
    const result = await analyze(outwardClosedCube());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(0);
  });

  it("a closed tetrahedron reports zero self-intersections", async () => {
    const result = await analyze(closedTetrahedron());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(0);
  });

  it("excludes ordinary edge-sharing adjacency from the self-intersection count", async () => {
    const result = await analyze(adjacentSharedEdgeTriangles());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(0);
  });

  it("tests (does not blanket-exclude) shared-vertex-only triangles, and finds them non-intersecting when they don't actually cross", async () => {
    const result = await analyze(sharedVertexOnlyTriangles());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(0);
  });

  it("detects a genuine proper crossing between two otherwise-unrelated triangles", async () => {
    const result = await analyze(properTriangleIntersection());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(1);
    expect(result.involvedTriangleCount).toBe(2);
    expect(result.samplePairs).toHaveLength(1);
  });

  it("detects non-adjacent coplanar overlap as an intersection", async () => {
    const result = await analyze(nonAdjacentCoplanarOverlap());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(1);
  });

  it("excludes an already-reported duplicate face pair from the self-intersection count", async () => {
    const result = await analyze(duplicateFaceSameWinding());
    expect(result.status).toBe("completed");
    expect(result.intersectingPairCount).toBe(0);
  });

  it("reports 'not-checked' rather than 'zero found' when the candidate-pair ceiling is exceeded", async () => {
    // Build a mesh of many triangles that all mutually overlap in bounding box, forcing candidate pairs past a tiny ceiling.
    const many: number[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(0, 0, i * 0.001, 1, 0, i * 0.001, 0, 1, i * 0.001);
    }
    const positions = Float32Array.from(many);
    const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: 1_000_000 });
    const inc = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: 1_000_000 });
    const dup = analyzeDuplicateFaces(mesh.validTriangles, { maxGroups: 1000, maxTriangleIndicesPerGroup: 100 });
    const result = await analyzeSelfIntersections(mesh.validTriangles, mesh.vertices, inc.edgesByKey, dup.groups, mesh.bounds, { ...LIMITS, maxCandidatePairs: 3 });
    expect(result.status).toBe("not-checked");
  });
});
