import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import { buildIndexedMesh, collapseEdge } from "./indexed-mesh";
import { evaluateQuadric } from "./quadric";
import { buildInitialCandidates, computeVertexQuadrics, regenerateLocalCandidates, scoreEdge } from "./edge-candidates";

const DEFAULT_LIMITS = { maxUniqueVertices: 100_000 };
const EDGE_LIMITS = { maxEdgeRecords: 100_000 };

/** A flat NxN grid — every interior face shares the same plane, so every interior vertex's quadric has a well-defined, unique zero-cost optimum on that plane. */
function grid(n: number): Float32Array {
  const p = (x: number, y: number): [number, number, number] => [x, y, 0];
  const out: number[] = [];
  const push = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => out.push(...a, ...b, ...c);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const a = p(gx, gy);
      const b = p(gx + 1, gy);
      const c = p(gx + 1, gy + 1);
      const d = p(gx, gy + 1);
      push(a, b, c);
      push(a, c, d);
    }
  }
  return Float32Array.from(out);
}

async function build(positions: Float32Array) {
  const canonical = await buildCanonicalMesh(positions, DEFAULT_LIMITS);
  const edges = buildEdgeIncidence(canonical.validTriangles, EDGE_LIMITS);
  const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
  const mesh = buildIndexedMesh(canonical, edges, shells);
  return { mesh };
}

describe("computeVertexQuadrics", () => {
  it("gives every vertex on one flat plane a zero-error quadric at any point on that plane", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(evaluateQuadric(quadrics[v], [1.5, 1.5, 0])).toBeCloseTo(0, 6);
    }
  });

  it("gives a vertex off the plane a positive error", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    expect(evaluateQuadric(quadrics[0], [0, 0, 5])).toBeGreaterThan(0);
  });
});

describe("scoreEdge", () => {
  it("scores an edge between two coplanar vertices as (near-)zero cost at a finite proposed position", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    const candidate = scoreEdge(mesh, quadrics, 0, 1, 0);
    expect(candidate.cost).toBeCloseTo(0, 4);
    expect(candidate.position.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("is deterministic: scoring the same edge twice gives the identical position and cost", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    const a = scoreEdge(mesh, quadrics, 0, 1, 0);
    const b = scoreEdge(mesh, quadrics, 0, 1, 0);
    expect(a).toEqual(b);
  });

  it("falls back to a deterministic position (never NaN) when the combined quadric is singular", async () => {
    // A single flat pair of triangles gives every vertex a rank-deficient
    // quadric (all constraints lie in one plane) — solveOptimalPosition
    // itself reports "not ok" for a genuinely singular 3x3 system, but
    // scoreEdge must still produce a usable, finite fallback position.
    const single = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const canonical = await buildCanonicalMesh(single, DEFAULT_LIMITS);
    const edges = buildEdgeIncidence(canonical.validTriangles, EDGE_LIMITS);
    const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
    const mesh = buildIndexedMesh(canonical, edges, shells);
    const quadrics = computeVertexQuadrics(mesh);
    const candidate = scoreEdge(mesh, quadrics, 0, 1, 0);
    expect(candidate.position.every((v) => Number.isFinite(v))).toBe(true);
    expect(Number.isFinite(candidate.cost)).toBe(true);
  });
});

describe("buildInitialCandidates", () => {
  it("produces exactly one candidate per unique active edge", async () => {
    const { mesh } = await build(grid(2)); // 9 vertices, 8 triangles, 16 edges
    const quadrics = computeVertexQuadrics(mesh);
    const heap = buildInitialCandidates(mesh, quadrics, { maxEntries: 10_000 });
    // Count distinct edges directly from triangle data as the expected value.
    const expected = new Set<string>();
    for (let t = 0; t < mesh.triangleCount; t++) {
      const base = t * 3;
      const [a, b, c] = [mesh.triangleVertexIds[base], mesh.triangleVertexIds[base + 1], mesh.triangleVertexIds[base + 2]];
      for (const [x, y] of [[a, b], [b, c], [c, a]]) expected.add(`${Math.min(x, y)}_${Math.max(x, y)}`);
    }
    expect(heap.size()).toBe(expected.size);
  });

  it("pops the globally lowest-cost candidate first", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    const heap = buildInitialCandidates(mesh, quadrics, { maxEntries: 10_000 });
    const first = heap.pop()!;
    const second = heap.pop()!;
    expect(first.cost).toBeLessThanOrEqual(second.cost);
  });
});

describe("regenerateLocalCandidates", () => {
  it("only pushes candidates for the surviving vertex's CURRENT neighbors, not a global rebuild", async () => {
    const { mesh } = await build(grid(3));
    const quadrics = computeVertexQuadrics(mesh);
    const heap = buildInitialCandidates(mesh, quadrics, { maxEntries: 10_000 });
    const sizeBeforeCollapse = heap.size();

    // Simulate a collapse: merge vertex 0 into vertex 1.
    collapseEdge(mesh, 0, 1, [0.5, 0, 0]);
    quadrics[1] = { ...quadrics[0] }; // placeholder — the real update rule is exercised in simplify.test.ts's integration tests
    const pushed = regenerateLocalCandidates(mesh, quadrics, 1, heap, { maxEntries: 10_000 });

    // Only vertex 1's current (post-collapse) neighbor count worth of new entries were added — never the whole mesh's edge count again.
    expect(pushed).toBeLessThan(sizeBeforeCollapse);
    expect(pushed).toBeGreaterThan(0);
  });
});
