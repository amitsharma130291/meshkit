/**
 * The collapse safety policy: every reason an edge collapse must be
 * rejected, checked before `indexed-mesh.ts#collapseEdge` ever mutates
 * anything. `simplify.ts`'s main loop calls this on its best remaining
 * candidate and skips straight to the next one on any rejection — a
 * rejected collapse never partially applies.
 *
 * Boundary policy (documented, not just implemented): a collapse is only
 * ever allowed between two boundary vertices that are ADJACENT ON THE
 * SAME CLOSED boundary loop (an actual boundary edge of a `closed-loop`
 * boundary component from `mesh/boundary-components.ts` — open-chain,
 * branched and non-simple components are never eligible at all, the same
 * "closed-simple-only" policy Phase 6's hole-filling already uses).
 * Collapsing two loop-adjacent vertices only ever shortens that one loop
 * by one vertex — it can never join two loops or split one, since a
 * non-adjacent pair is rejected outright. A boundary vertex may never
 * collapse into an interior vertex (`boundary-interior-mixed`), which is
 * what keeps a boundary from being pulled into the interior or a new hole
 * from opening.
 *
 * Interior safety uses the standard "link condition" (Hoppe et al.): for
 * an edge (a,b) with no boundary vertices, the collapse is manifold-safe
 * iff `neighbors(a) ∩ neighbors(b)` equals exactly the third-corner
 * vertices of the (1 or 2) triangles that already contain edge (a,b). Any
 * OTHER shared neighbor means the two vertices' triangle fans already
 * touch somewhere else in the mesh, and merging them would pinch the
 * surface into a non-manifold vertex/edge there.
 */
import { edgeKeyString } from "../mesh/topology-types";
import type { BoundaryAnalysis } from "../mesh/boundary-components";
import { getIncidentTriangles, getTriangleVertexIds, getVertexPosition, type IndexedMesh } from "./indexed-mesh";

export type CollapseRejectionReason =
  | "non-finite-position"
  | "different-shells"
  | "boundary-interior-mixed"
  | "boundary-non-adjacent"
  | "would-create-degenerate-triangle"
  | "would-create-duplicate-triangle"
  | "link-condition-failed"
  | "normal-flip-exceeded"
  | "shell-would-drop-below-minimum";

export interface CollapsePolicy {
  minTrianglesPerShell: number;
  /** A surviving triangle's normal must not rotate past this angle from its pre-collapse normal. */
  maxNormalFlipAngleDeg: number;
  /** Precomputed once per mesh via `boundaryEdgeKeysFromClosedLoops()` — every edge belonging to a closed-loop boundary component. */
  boundaryEdgeKeys: ReadonlySet<string>;
}

export const DEFAULT_COLLAPSE_POLICY: Omit<CollapsePolicy, "boundaryEdgeKeys"> = {
  minTrianglesPerShell: 4,
  maxNormalFlipAngleDeg: 90,
};

export interface CollapseValidationResult {
  safe: boolean;
  reason: CollapseRejectionReason | null;
}

const DEGENERATE_AREA_EPSILON = 1e-12;

/** Every boundary edge belonging to a `closed-loop` component only — the sole basis for the boundary-adjacency check. */
export function boundaryEdgeKeysFromClosedLoops(boundary: BoundaryAnalysis): Set<string> {
  const keys = new Set<string>();
  for (const component of boundary.components) {
    if (component.kind !== "closed-loop") continue;
    for (const edge of component.edges) keys.add(edgeKeyString(edge.a, edge.b));
  }
  return keys;
}

function triangleNormal(p0: readonly [number, number, number], p1: readonly [number, number, number], p2: readonly [number, number, number]): [number, number, number] | null {
  const e1: [number, number, number] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2: [number, number, number] = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < DEGENERATE_AREA_EPSILON) return null;
  return [nx / length, ny / length, nz / length];
}

function shellTriangleCount(mesh: IndexedMesh, shellId: number): number {
  let count = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (mesh.triangleActive[t] === 0) continue;
    const [a] = getTriangleVertexIds(mesh, t);
    if (mesh.vertexShellId[a] === shellId) count++;
  }
  return count;
}

export function validateCollapse(mesh: IndexedMesh, from: number, to: number, newPosition: readonly [number, number, number], policy: CollapsePolicy): CollapseValidationResult {
  if (!newPosition.every((v) => Number.isFinite(v))) {
    return { safe: false, reason: "non-finite-position" };
  }

  const shellId = mesh.vertexShellId[from];
  if (shellId !== mesh.vertexShellId[to]) {
    return { safe: false, reason: "different-shells" };
  }

  const fromIsBoundary = mesh.vertexIsBoundary[from] === 1;
  const toIsBoundary = mesh.vertexIsBoundary[to] === 1;
  if (fromIsBoundary !== toIsBoundary) {
    return { safe: false, reason: "boundary-interior-mixed" };
  }
  if (fromIsBoundary && toIsBoundary) {
    if (!policy.boundaryEdgeKeys.has(edgeKeyString(from, to))) {
      return { safe: false, reason: "boundary-non-adjacent" };
    }
  } else {
    // Interior-only: the link condition guards manifold safety.
    const sharedTriangles = [...getIncidentTriangles(mesh, from)].filter((t) => getIncidentTriangles(mesh, to).has(t));
    if (sharedTriangles.length === 0 || sharedTriangles.length > 2) {
      return { safe: false, reason: "link-condition-failed" };
    }
    const expectedShared = new Set<number>();
    for (const t of sharedTriangles) {
      for (const v of getTriangleVertexIds(mesh, t)) {
        if (v !== from && v !== to) expectedShared.add(v);
      }
    }
    const neighborsOf = (v: number): Set<number> => {
      const neighbors = new Set<number>();
      for (const t of getIncidentTriangles(mesh, v)) {
        for (const corner of getTriangleVertexIds(mesh, t)) {
          if (corner !== v) neighbors.add(corner);
        }
      }
      return neighbors;
    };
    const neighborsFrom = neighborsOf(from);
    const neighborsTo = neighborsOf(to);
    const actualShared = new Set<number>();
    for (const v of neighborsFrom) if (neighborsTo.has(v)) actualShared.add(v);
    if (actualShared.size !== expectedShared.size || [...actualShared].some((v) => !expectedShared.has(v))) {
      return { safe: false, reason: "link-condition-failed" };
    }
  }

  // Degenerate/duplicate checks over every triangle that would survive
  // renumbered (incident to `from` or `to`, minus the ones that collapse away).
  const affected = new Set<number>([...getIncidentTriangles(mesh, from), ...getIncidentTriangles(mesh, to)]);
  const survivingTriples: string[] = [];
  for (const t of affected) {
    const verts = getTriangleVertexIds(mesh, t).map((v) => (v === from ? to : v));
    if (verts[0] === verts[1] || verts[1] === verts[2] || verts[0] === verts[2]) continue; // collapses away — fine

    const positions = verts.map((v) => (v === to ? newPosition : getVertexPosition(mesh, v))) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const normalAfter = triangleNormal(positions[0], positions[1], positions[2]);
    if (!normalAfter) {
      return { safe: false, reason: "would-create-degenerate-triangle" };
    }

    const before = getTriangleVertexIds(mesh, t).map((v) => getVertexPosition(mesh, v)) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const normalBefore = triangleNormal(before[0], before[1], before[2]);
    if (normalBefore) {
      const dot = normalBefore[0] * normalAfter[0] + normalBefore[1] * normalAfter[1] + normalBefore[2] * normalAfter[2];
      const clamped = Math.min(1, Math.max(-1, dot));
      const angleDeg = (Math.acos(clamped) * 180) / Math.PI;
      if (angleDeg > policy.maxNormalFlipAngleDeg) {
        return { safe: false, reason: "normal-flip-exceeded" };
      }
    }

    const sortedKey = [...verts].sort((a, b) => a - b).join("_");
    if (survivingTriples.includes(sortedKey)) {
      return { safe: false, reason: "would-create-duplicate-triangle" };
    }
    survivingTriples.push(sortedKey);
  }

  const removedCount = [...getIncidentTriangles(mesh, from)].filter((t) => getIncidentTriangles(mesh, to).has(t)).length;
  const remainingInShell = shellTriangleCount(mesh, shellId) - removedCount;
  if (remainingInShell < policy.minTrianglesPerShell) {
    return { safe: false, reason: "shell-would-drop-below-minimum" };
  }

  return { safe: true, reason: null };
}
