import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import {
  activeTriangleCount,
  activeVertexCount,
  buildIndexedMesh,
  collapseEdge,
  getIncidentTriangles,
  getTriangleVertexIds,
  getVertexPosition,
} from "./indexed-mesh";

const DEFAULT_LIMITS = { maxUniqueVertices: 100_000 };
const EDGE_LIMITS = { maxEdgeRecords: 100_000 };

/** A unit square split into two triangles (0,0,0)-(1,0,0)-(1,1,0)-(0,1,0). */
function openQuad(): Float32Array {
  return Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, // tri 0
    0, 0, 0, 1, 1, 0, 0, 1, 0, // tri 1
  ]);
}

/** A closed tetrahedron. */
function tetrahedron(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0.5, 1, 0];
  const d: [number, number, number] = [0.5, 0.4, 1];
  const out: number[] = [];
  const push = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => out.push(...p, ...q, ...r);
  push(a, b, c);
  push(a, c, d);
  push(a, d, b);
  push(b, d, c);
  return Float32Array.from(out);
}

async function build(positions: Float32Array) {
  const canonical = await buildCanonicalMesh(positions, DEFAULT_LIMITS);
  const edges = buildEdgeIncidence(canonical.validTriangles, EDGE_LIMITS);
  const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
  return { canonical, edges, shells };
}

describe("buildIndexedMesh", () => {
  it("reuses the canonical mesh's exact vertex count and positions (never re-derives vertex identity)", async () => {
    const { canonical, edges, shells } = await build(openQuad());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    expect(mesh.vertexCount).toBe(canonical.uniqueVertexCount);
    for (let i = 0; i < canonical.uniqueVertexCount; i++) {
      expect(getVertexPosition(mesh, i)).toEqual([canonical.vertices[i * 3], canonical.vertices[i * 3 + 1], canonical.vertices[i * 3 + 2]]);
    }
  });

  it("never mutates the canonical mesh's own source position array", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const before = canonical.vertices.slice();
    const mesh = buildIndexedMesh(canonical, edges, shells);
    collapseEdge(mesh, 0, 1, [0.5, 0, 0]);
    expect(canonical.vertices).toEqual(before);
  });

  it("builds correct vertex-to-triangle incidence", async () => {
    const { canonical, edges, shells } = await build(openQuad());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    // The shared diagonal vertices (0,0,0) and (1,1,0) each touch both triangles.
    const sharedVertexIncidence = [...getIncidentTriangles(mesh, 0)].sort();
    expect(sharedVertexIncidence).toEqual([0, 1]);
  });

  it("classifies every quad-boundary vertex as boundary (an open mesh has no interior vertices here)", async () => {
    const { canonical, edges, shells } = await build(openQuad());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(mesh.vertexIsBoundary[v]).toBe(1);
    }
  });

  it("classifies every tetrahedron vertex as interior (a closed mesh has no boundary)", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(mesh.vertexIsBoundary[v]).toBe(0);
    }
  });

  it("assigns deterministic, dense shell ids matching resolveTriangleShells", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    expect(mesh.shellCount).toBe(shells.shellCount);
  });

  it("gives every vertex and triangle a stable, deterministic 0-based id equal to its position in canonical order", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    expect(getTriangleVertexIds(mesh, 0)).toEqual(canonical.validTriangles[0].vertexIds);
  });
});

describe("collapseEdge", () => {
  it("removes triangles that become degenerate (repeated vertex) from the active topology", async () => {
    const { canonical, edges, shells } = await build(openQuad());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    const before = activeTriangleCount(mesh);
    // Collapse the shared diagonal edge (vertex 0 <-> vertex touching both triangles).
    const sharedVerts = [...getIncidentTriangles(mesh, 0)];
    expect(sharedVerts.length).toBe(2); // sanity: vertex 0 is the shared diagonal vertex
    const result = collapseEdge(mesh, 0, 2, [0.5, 0.5, 0]); // 0 and 2 are the diagonal's two endpoints in this fixture
    expect(activeTriangleCount(mesh)).toBeLessThan(before);
    expect(result.removedTriangleIndices.length).toBeGreaterThan(0);
    for (const removed of result.removedTriangleIndices) {
      expect(mesh.triangleActive[removed]).toBe(0);
    }
  });

  it("deactivates the collapsed-away vertex", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    const beforeCount = activeVertexCount(mesh);
    collapseEdge(mesh, 0, 1, [0.5, 0, 0]);
    expect(activeVertexCount(mesh)).toBe(beforeCount - 1);
    expect(mesh.vertexActive[0]).toBe(0);
  });

  it("moves the surviving vertex to the requested position", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    collapseEdge(mesh, 0, 1, [9, 9, 9]);
    expect(getVertexPosition(mesh, 1)).toEqual([9, 9, 9]);
  });

  it("reassigns every surviving incident triangle of the removed vertex to reference the surviving vertex instead", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    collapseEdge(mesh, 0, 1, [0.5, 0, 0]);
    for (let t = 0; t < mesh.triangleCount; t++) {
      if (mesh.triangleActive[t] === 0) continue;
      expect(getTriangleVertexIds(mesh, t)).not.toContain(0);
    }
  });

  it("bumps the mesh's topology version on every collapse (candidate-invalidation signal)", async () => {
    const { canonical, edges, shells } = await build(tetrahedron());
    const mesh = buildIndexedMesh(canonical, edges, shells);
    const before = mesh.version;
    collapseEdge(mesh, 0, 1, [0.5, 0, 0]);
    expect(mesh.version).toBe(before + 1);
  });
});
