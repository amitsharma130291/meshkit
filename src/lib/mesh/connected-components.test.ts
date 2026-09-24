import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import { buildEdgeIncidence } from "./edge-incidence";
import { resolveTriangleShells } from "./connected-components";
import { closedTetrahedron, disconnectedShells, pointTouchingShells } from "../stl-diagnostics/test-fixtures";

const VERTEX_LIMITS = { maxUniqueVertices: 1_000_000 };
const EDGE_LIMITS = { maxEdgeRecords: 1_000_000 };

async function shellsFor(positions: Float32Array) {
  const mesh = await buildCanonicalMesh(positions, VERTEX_LIMITS);
  const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
  return resolveTriangleShells(mesh.validTriangles, inc.edgesByKey);
}

describe("resolveTriangleShells", () => {
  it("a single closed tetrahedron is one shell", async () => {
    const shells = await shellsFor(closedTetrahedron());
    expect(shells.shellCount).toBe(1);
    expect(shells.triangleIndicesByShell[0]).toHaveLength(4);
  });

  it("two edge-disjoint tetrahedra are two separate shells", async () => {
    const shells = await shellsFor(disconnectedShells());
    expect(shells.shellCount).toBe(2);
    expect(shells.triangleIndicesByShell.map((s) => s.length).sort()).toEqual([4, 4]);
  });

  it("two tetrahedra sharing only one vertex position remain two separate shells", async () => {
    const shells = await shellsFor(pointTouchingShells());
    expect(shells.shellCount).toBe(2);
    expect(shells.triangleIndicesByShell.map((s) => s.length).sort()).toEqual([4, 4]);
  });
});
