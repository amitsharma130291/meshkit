import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import { buildEdgeIncidence } from "./edge-incidence";
import { analyzeBoundaryComponents } from "./boundary-components";
import type { EdgeRecord } from "./topology-types";
import { branchedBoundaryWithDanglingFlap, closedTetrahedron, openCubeMissingFace, singleBoundaryLoop } from "../stl-diagnostics/test-fixtures";

const VERTEX_LIMITS = { maxUniqueVertices: 1_000_000 };
const EDGE_LIMITS = { maxEdgeRecords: 1_000_000 };
const BOUNDARY_LIMITS = { maxComponents: 1000, maxSampleVerticesPerComponent: 100 };

async function boundaryFor(positions: Float32Array) {
  const mesh = await buildCanonicalMesh(positions, VERTEX_LIMITS);
  const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
  return analyzeBoundaryComponents(inc.edgesByKey, BOUNDARY_LIMITS);
}

/** Builds a synthetic boundary-only edge map for a graph shape, bypassing full 3D mesh construction — see test-fixtures.ts's module doc for why a pure open-chain boundary can't be realized as an actual embedded triangle patch. */
function edgeRecord(a: number, b: number): EdgeRecord {
  return { key: `${Math.min(a, b)}_${Math.max(a, b)}`, a: Math.min(a, b), b: Math.max(a, b), uses: [{ triangleIndex: 0, from: a, to: b }], edgeClass: "boundary", windingConsistent: true };
}

describe("analyzeBoundaryComponents — mesh-derived cases", () => {
  it("a closed tetrahedron has zero boundary edges", async () => {
    const result = await boundaryFor(closedTetrahedron());
    expect(result.totalBoundaryEdges).toBe(0);
    expect(result.components).toHaveLength(0);
  });

  it("a single quad's 4 outer edges form one closed loop", async () => {
    const result = await boundaryFor(singleBoundaryLoop());
    expect(result.totalBoundaryEdges).toBe(4);
    expect(result.closedLoopCount).toBe(1);
    expect(result.components[0].vertexCount).toBe(4);
  });

  it("a cube missing one face has its 4 boundary edges form one closed loop", async () => {
    const result = await boundaryFor(openCubeMissingFace());
    expect(result.totalBoundaryEdges).toBe(4);
    expect(result.closedLoopCount).toBe(1);
    expect(result.openChainCount).toBe(0);
    expect(result.branchedCount).toBe(0);
  });

  it("a dangling flap off a closed cone loop produces one branched boundary component", async () => {
    const result = await boundaryFor(branchedBoundaryWithDanglingFlap());
    expect(result.branchedCount).toBe(1);
    expect(result.closedLoopCount).toBe(0);
    expect(result.components[0].kind).toBe("branched");
  });
});

describe("analyzeBoundaryComponents — classifier correctness against a synthetic edge graph", () => {
  it("classifies a simple path (2 degree-1 endpoints, rest degree 2) as an open chain", () => {
    // Path: 0 - 1 - 2 - 3
    const edgesByKey = new Map<string, EdgeRecord>([
      ["0_1", edgeRecord(0, 1)],
      ["1_2", edgeRecord(1, 2)],
      ["2_3", edgeRecord(2, 3)],
    ]);
    const result = analyzeBoundaryComponents(edgesByKey, BOUNDARY_LIMITS);
    expect(result.openChainCount).toBe(1);
    expect(result.components[0].kind).toBe("open-chain");
    expect(result.components[0].edgeCount).toBe(3);
    expect(result.components[0].vertexCount).toBe(4);
  });

  it("classifies a simple cycle as a closed loop", () => {
    const edgesByKey = new Map<string, EdgeRecord>([
      ["0_1", edgeRecord(0, 1)],
      ["1_2", edgeRecord(1, 2)],
      ["2_0", edgeRecord(2, 0)],
    ]);
    const result = analyzeBoundaryComponents(edgesByKey, BOUNDARY_LIMITS);
    expect(result.closedLoopCount).toBe(1);
  });

  it("classifies a vertex with 3 incident boundary edges as branched", () => {
    // A "Y": center 0 connected to 1, 2, 3.
    const edgesByKey = new Map<string, EdgeRecord>([
      ["0_1", edgeRecord(0, 1)],
      ["0_2", edgeRecord(0, 2)],
      ["0_3", edgeRecord(0, 3)],
    ]);
    const result = analyzeBoundaryComponents(edgesByKey, BOUNDARY_LIMITS);
    expect(result.branchedCount).toBe(1);
  });

  it("truncates the component list at maxComponents but still reports the true total boundary edge count", () => {
    const edgesByKey = new Map<string, EdgeRecord>();
    // 3 separate closed triangles (disjoint vertex sets) = 3 components, 9 boundary edges.
    for (let g = 0; g < 3; g++) {
      const base = g * 10;
      edgesByKey.set(`${base}_${base + 1}`, edgeRecord(base, base + 1));
      edgesByKey.set(`${base + 1}_${base + 2}`, edgeRecord(base + 1, base + 2));
      edgesByKey.set(`${base + 2}_${base}`, edgeRecord(base + 2, base));
    }
    const result = analyzeBoundaryComponents(edgesByKey, { maxComponents: 2, maxSampleVerticesPerComponent: 100 });
    expect(result.totalBoundaryEdges).toBe(9);
    expect(result.components).toHaveLength(2);
  });
});
