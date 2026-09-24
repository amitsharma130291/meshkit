/**
 * Builds and locally maintains the edge-collapse candidate set. Every
 * vertex's quadric is the sum of its incident (active) triangles' own
 * plane quadrics (Garland & Heckbert's own update rule — after a
 * collapse, the surviving vertex's quadric becomes the SUM of the two
 * merged vertices' quadrics, never recomputed from scratch). Only
 * `regenerateLocalCandidates()` runs after a collapse — it touches
 * exactly the surviving vertex's current neighbor edges, never the whole
 * mesh, which is what keeps simplification from being an all-pairs or
 * global-resort operation.
 */
import { addQuadric, evaluateQuadric, solveOptimalPosition, triangleQuadric, type Quadric, ZERO_QUADRIC } from "./quadric";
import { getIncidentTriangles, getTriangleVertexIds, getVertexPosition, type IndexedMesh } from "./indexed-mesh";
import { CollapseHeap, type CollapseCandidate, type CollapseHeapLimits } from "./collapse-heap";

export function computeVertexQuadrics(mesh: IndexedMesh): Quadric[] {
  const quadrics: Quadric[] = new Array(mesh.vertexCount).fill(ZERO_QUADRIC);
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (mesh.triangleActive[t] === 0) continue;
    const [a, b, c] = getTriangleVertexIds(mesh, t);
    let q: Quadric;
    try {
      q = triangleQuadric(getVertexPosition(mesh, a), getVertexPosition(mesh, b), getVertexPosition(mesh, c));
    } catch {
      continue; // a triangle that only became degenerate mid-simplification contributes no plane constraint
    }
    quadrics[a] = addQuadric(quadrics[a], q);
    quadrics[b] = addQuadric(quadrics[b], q);
    quadrics[c] = addQuadric(quadrics[c], q);
  }
  return quadrics;
}

/**
 * Deterministic fallback order when the combined quadric is singular (no
 * unique minimizer): try the edge midpoint, then the `from` endpoint,
 * then the `to` endpoint — in that fixed order, picking whichever is
 * FIRST to be finite (a plain, always-reproducible rule; not "whichever
 * has lowest error," which risks tiny floating-point ties resolving
 * differently across platforms).
 */
function fallbackPosition(mesh: IndexedMesh, from: number, to: number): [number, number, number] {
  const pf = getVertexPosition(mesh, from);
  const pt = getVertexPosition(mesh, to);
  const midpoint: [number, number, number] = [(pf[0] + pt[0]) / 2, (pf[1] + pt[1]) / 2, (pf[2] + pt[2]) / 2];
  return midpoint;
}

export function scoreEdge(mesh: IndexedMesh, quadrics: readonly Quadric[], from: number, to: number, versionAtInsertion: number): CollapseCandidate {
  const combined = addQuadric(quadrics[from], quadrics[to]);
  const solved = solveOptimalPosition(combined);
  const position = solved.ok ? solved.position! : fallbackPosition(mesh, from, to);
  const cost = evaluateQuadric(combined, position);
  return { from, to, cost, position, versionAtInsertion };
}

function activeNeighborsOf(mesh: IndexedMesh, vertexId: number): Set<number> {
  const neighbors = new Set<number>();
  for (const t of getIncidentTriangles(mesh, vertexId)) {
    for (const v of getTriangleVertexIds(mesh, t)) {
      if (v !== vertexId) neighbors.add(v);
    }
  }
  return neighbors;
}

export function buildInitialCandidates(mesh: IndexedMesh, quadrics: readonly Quadric[], limits: CollapseHeapLimits): CollapseHeap {
  const heap = new CollapseHeap(limits);
  const seen = new Set<string>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (mesh.triangleActive[t] === 0) continue;
    const [a, b, c] = getTriangleVertexIds(mesh, t);
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      if (seen.has(key)) continue;
      seen.add(key);
      heap.push(scoreEdge(mesh, quadrics, x, y, mesh.version));
    }
  }
  return heap;
}

/**
 * After `to` absorbs a collapse, pushes a fresh candidate for every edge
 * from `to` to its CURRENT active neighbors only — never touches any
 * other part of the heap or mesh. Returns how many were pushed.
 */
export function regenerateLocalCandidates(mesh: IndexedMesh, quadrics: readonly Quadric[], to: number, heap: CollapseHeap, limits: CollapseHeapLimits): number {
  const remaining = limits.maxEntries - heap.size();
  const neighbors = [...activeNeighborsOf(mesh, to)].slice(0, Math.max(0, remaining));
  for (const neighbor of neighbors) {
    heap.push(scoreEdge(mesh, quadrics, to, neighbor, mesh.version));
  }
  return neighbors.length;
}
