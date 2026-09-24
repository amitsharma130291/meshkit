import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import { buildEdgeIncidence } from "./edge-incidence";
import {
  closedTetrahedron,
  inconsistentAdjacentWinding,
  openCubeMissingFace,
  outwardClosedCube,
  threeTrianglesSharingOneEdge,
} from "../stl-diagnostics/test-fixtures";

const VERTEX_LIMITS = { maxUniqueVertices: 1_000_000 };
const EDGE_LIMITS = { maxEdgeRecords: 1_000_000 };

describe("buildEdgeIncidence", () => {
  it("a closed tetrahedron has all manifold edges, no boundary, no non-manifold, no winding conflicts", async () => {
    const mesh = await buildCanonicalMesh(closedTetrahedron(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect(inc.boundaryEdgeCount).toBe(0);
    expect(inc.nonManifoldEdgeCount).toBe(0);
    expect(inc.windingConflictEdgeCount).toBe(0);
    // 4 triangles * 3 edges / 2 shared = 6 edges.
    expect(inc.manifoldEdgeCount).toBe(6);
  });

  it("a closed cube has 18 manifold edges and no boundary/non-manifold edges", async () => {
    const mesh = await buildCanonicalMesh(outwardClosedCube(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect(inc.boundaryEdgeCount).toBe(0);
    expect(inc.nonManifoldEdgeCount).toBe(0);
    expect(inc.manifoldEdgeCount).toBe(18);
  });

  it("removing one cube face produces exactly 4 boundary edges", async () => {
    const mesh = await buildCanonicalMesh(openCubeMissingFace(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect(inc.boundaryEdgeCount).toBe(4);
    expect(inc.nonManifoldEdgeCount).toBe(0);
  });

  it("an edge shared by 3 triangles is classified non-manifold, and its incident triangles' other edges are boundary", async () => {
    const mesh = await buildCanonicalMesh(threeTrianglesSharingOneEdge(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect(inc.nonManifoldEdgeCount).toBe(1);
    expect(inc.boundaryEdgeCount).toBe(6); // 3 triangles * 2 own edges each
    expect(inc.manifoldEdgeCount).toBe(0);
  });

  it("two triangles traversing a shared edge in the same direction are flagged as a winding conflict, but the edge is still classified manifold", async () => {
    const mesh = await buildCanonicalMesh(inconsistentAdjacentWinding(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect(inc.windingConflictEdgeCount).toBe(1);
    const conflicted = [...inc.edgesByKey.values()].find((e) => !e.windingConsistent)!;
    expect(conflicted.edgeClass).toBe("manifold");
    expect(conflicted.uses).toHaveLength(2);
  });

  it("a properly-wound shared edge is windingConsistent", async () => {
    const mesh = await buildCanonicalMesh(closedTetrahedron(), VERTEX_LIMITS);
    const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
    expect([...inc.edgesByKey.values()].every((e) => e.windingConsistent)).toBe(true);
  });
});
