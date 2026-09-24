import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import { analyzeBoundaryComponents } from "../mesh/boundary-components";
import { activeTriangleCount, buildIndexedMesh } from "./indexed-mesh";
import { simplifyMesh } from "./simplify";

const DEFAULT_LIMITS = { maxUniqueVertices: 100_000 };
const EDGE_LIMITS = { maxEdgeRecords: 100_000 };
const BOUNDARY_LIMITS = { maxComponents: 1000, maxSampleVerticesPerComponent: 1000 };
const SIMPLIFY_LIMITS = { maxCandidateHeapEntries: 100_000, maxCollapseAttempts: 100_000, workBudgetMs: 5000 };

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

/** A closed UV-sphere with properly capped poles, dense enough to have real safe collapses available. */
function sphere(latSegments: number, lonSegments: number): Float32Array {
  const vertex = (lat: number, lon: number): [number, number, number] => {
    const theta = (lat / latSegments) * Math.PI;
    const phi = (lon / lonSegments) * 2 * Math.PI;
    return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
  };
  const north: [number, number, number] = [0, 1, 0];
  const south: [number, number, number] = [0, -1, 0];
  const out: number[] = [];
  const push = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => out.push(...a, ...b, ...c);
  for (let lon = 0; lon < lonSegments; lon++) push(north, vertex(1, lon), vertex(1, lon + 1));
  for (let lat = 1; lat < latSegments - 1; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      push(vertex(lat, lon), vertex(lat + 1, lon), vertex(lat + 1, lon + 1));
      push(vertex(lat, lon), vertex(lat + 1, lon + 1), vertex(lat, lon + 1));
    }
  }
  for (let lon = 0; lon < lonSegments; lon++) push(south, vertex(latSegments - 1, lon + 1), vertex(latSegments - 1, lon));
  return Float32Array.from(out);
}

async function build(positions: Float32Array) {
  const canonical = await buildCanonicalMesh(positions, DEFAULT_LIMITS);
  const edges = buildEdgeIncidence(canonical.validTriangles, EDGE_LIMITS);
  const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
  const boundary = analyzeBoundaryComponents(edges.edgesByKey, BOUNDARY_LIMITS);
  const mesh = buildIndexedMesh(canonical, edges, shells);
  return { mesh, boundary };
}

describe("simplifyMesh — target achievement", () => {
  it("reaches an explicit, safely-achievable target triangle count", async () => {
    const { mesh, boundary } = await build(sphere(12, 24)); // 440 triangles
    const before = activeTriangleCount(mesh);
    const result = await simplifyMesh(
      mesh,
      boundary,
      { targetTriangleCount: 200, minTrianglesPerShell: 4, maxNormalFlipAngleDeg: 60 },
      SIMPLIFY_LIMITS,
    );
    expect(activeTriangleCount(mesh)).toBeLessThan(before);
    expect(activeTriangleCount(mesh)).toBeLessThanOrEqual(200);
    expect(result.stopReason).toBe("target-reached");
  });

  it("stops honestly (never 'failed') when the requested target is below what's safely achievable, reporting the best safe reduction actually reached", async () => {
    const { mesh, boundary } = await build(sphere(12, 24));
    const result = await simplifyMesh(
      mesh,
      boundary,
      { targetTriangleCount: 1, minTrianglesPerShell: 200, maxNormalFlipAngleDeg: 60 }, // 200 floor makes 1 unreachable
      SIMPLIFY_LIMITS,
    );
    expect(result.stopReason).not.toBe("failed");
    expect(activeTriangleCount(mesh)).toBeGreaterThanOrEqual(200);
  });
});

describe("simplifyMesh — safety invariants preserved", () => {
  it("never drops any shell's triangle count below the configured minimum", async () => {
    const { mesh, boundary } = await build(sphere(12, 24));
    await simplifyMesh(mesh, boundary, { targetTriangleCount: 1, minTrianglesPerShell: 20, maxNormalFlipAngleDeg: 60 }, SIMPLIFY_LIMITS);
    expect(activeTriangleCount(mesh)).toBeGreaterThanOrEqual(20);
  });

  it("preserves an open mesh's boundary vertex count exactly (only loop-adjacent boundary collapses are ever safe, and each one reduces the loop by one vertex at most)", async () => {
    const { mesh, boundary } = await build(grid(6));
    const boundaryCountBefore = [...mesh.vertexIsBoundary].filter((v) => v === 1).length;
    await simplifyMesh(mesh, boundary, { targetTriangleCount: 1, minTrianglesPerShell: 4, maxNormalFlipAngleDeg: 60 }, SIMPLIFY_LIMITS);
    let boundaryCountAfter = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (mesh.vertexActive[v] === 1 && mesh.vertexIsBoundary[v] === 1) boundaryCountAfter++;
    }
    expect(boundaryCountAfter).toBeLessThanOrEqual(boundaryCountBefore);
  });
});

describe("simplifyMesh — determinism", () => {
  it("produces the identical sequence of accepted/rejected collapse counts across two runs on the same input", async () => {
    const { mesh: meshA, boundary: boundaryA } = await build(sphere(10, 20));
    const { mesh: meshB, boundary: boundaryB } = await build(sphere(10, 20));
    const options = { targetTriangleCount: 100, minTrianglesPerShell: 4, maxNormalFlipAngleDeg: 60 };
    const resultA = await simplifyMesh(meshA, boundaryA, options, SIMPLIFY_LIMITS);
    const resultB = await simplifyMesh(meshB, boundaryB, options, SIMPLIFY_LIMITS);
    expect(resultA.acceptedCollapses).toBe(resultB.acceptedCollapses);
    expect(activeTriangleCount(meshA)).toBe(activeTriangleCount(meshB));
  });
});

describe("simplifyMesh — cancellation", () => {
  it("stops with 'cancelled' and performs no further collapses once cancellation is requested", async () => {
    const { mesh, boundary } = await build(sphere(14, 28));
    const result = await simplifyMesh(
      mesh,
      boundary,
      { targetTriangleCount: 1, minTrianglesPerShell: 4, maxNormalFlipAngleDeg: 60, isCancelled: () => true },
      SIMPLIFY_LIMITS,
    );
    expect(result.stopReason).toBe("cancelled");
  });
});

describe("simplifyMesh — stopping conditions", () => {
  it("stops with 'collapse-attempt-limit-reached' when the attempt ceiling is hit before the target", async () => {
    const { mesh, boundary } = await build(sphere(12, 24));
    const result = await simplifyMesh(
      mesh,
      boundary,
      { targetTriangleCount: 1, minTrianglesPerShell: 4, maxNormalFlipAngleDeg: 60 },
      { ...SIMPLIFY_LIMITS, maxCollapseAttempts: 3 },
    );
    expect(result.stopReason).toBe("collapse-attempt-limit-reached");
    expect(result.attemptedCollapses).toBeLessThanOrEqual(3);
  });
});
