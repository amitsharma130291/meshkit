/**
 * Builds the undirected edge map over a mesh's VALID (non-degenerate)
 * triangles, retaining every triangle's own directed traversal of each
 * edge. This is the single source of truth every later stage (boundary
 * components, shells, orientation) reads from — none of them re-derive
 * edge adjacency their own way.
 *
 * Definitions (precise and documented, per this phase's own requirement):
 * - boundary edge: exactly one incident triangle.
 * - manifold edge: exactly two incident triangles.
 * - non-manifold edge: three or more incident triangles.
 * - winding-inconsistent edge: two (or more) of its directed uses
 *   traverse it in the SAME direction (both `a→b`, or both `b→a`) — kept
 *   as its own boolean, orthogonal to the edge-count classification
 *   above, never folded into "non-manifold." A 2-triangle edge whose two
 *   uses run opposite directions (the normal, correctly-wound case) is
 *   `windingConsistent: true`; two triangles sharing an edge in the same
 *   direction is a winding conflict even though the edge is still
 *   manifold by the count-based definition.
 *
 * Degenerate triangles (see `canonical-vertices.ts`) never contribute an
 * edge here — a triangle with a repeated vertex has no well-defined third
 * edge, and a zero/near-zero-area triangle's "edges" would corrupt
 * boundary/shell/orientation analysis with spurious adjacency. This
 * module only ever sees `CanonicalMesh.validTriangles`.
 */
import { edgeKeyString, type CanonicalTriangle, type CanonicalVertexId, type EdgeRecord } from "./topology-types";

export interface EdgeIncidenceLimits {
  /** Hard ceiling on distinct edge records — protects against pathological allocation on an adversarial or corrupt file. */
  maxEdgeRecords: number;
}

export class EdgeRecordLimitExceededError extends Error {
  constructor() {
    super("edge record limit exceeded");
    this.name = "EdgeRecordLimitExceededError";
  }
}

export interface EdgeIncidence {
  edgesByKey: Map<string, EdgeRecord>;
  boundaryEdgeCount: number;
  manifoldEdgeCount: number;
  nonManifoldEdgeCount: number;
  windingConflictEdgeCount: number;
}

export function buildEdgeIncidence(triangles: readonly CanonicalTriangle[], limits: EdgeIncidenceLimits): EdgeIncidence {
  const edgesByKey = new Map<string, EdgeRecord>();

  for (const tri of triangles) {
    const [a, b, c] = tri.vertexIds;
    addUse(edgesByKey, tri.index, a, b, limits);
    addUse(edgesByKey, tri.index, b, c, limits);
    addUse(edgesByKey, tri.index, c, a, limits);
  }

  let boundaryEdgeCount = 0;
  let manifoldEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let windingConflictEdgeCount = 0;

  for (const edge of edgesByKey.values()) {
    const count = edge.uses.length;
    edge.edgeClass = count === 1 ? "boundary" : count === 2 ? "manifold" : "non-manifold";
    if (edge.edgeClass === "boundary") boundaryEdgeCount++;
    else if (edge.edgeClass === "manifold") manifoldEdgeCount++;
    else nonManifoldEdgeCount++;

    edge.windingConsistent = computeWindingConsistent(edge.uses, edge.a);
    if (!edge.windingConsistent) windingConflictEdgeCount++;
  }

  return { edgesByKey, boundaryEdgeCount, manifoldEdgeCount, nonManifoldEdgeCount, windingConflictEdgeCount };
}

function addUse(edgesByKey: Map<string, EdgeRecord>, triangleIndex: number, from: CanonicalVertexId, to: CanonicalVertexId, limits: EdgeIncidenceLimits): void {
  const key = edgeKeyString(from, to);
  let edge = edgesByKey.get(key);
  if (!edge) {
    if (edgesByKey.size >= limits.maxEdgeRecords) throw new EdgeRecordLimitExceededError();
    edge = { key, a: from < to ? from : to, b: from < to ? to : from, uses: [], edgeClass: "boundary", windingConsistent: true };
    edgesByKey.set(key, edge);
  }
  edge.uses.push({ triangleIndex, from, to });
}

/** `true` unless two or more uses share the exact same directed traversal (both `a→b`, or both `b→a`). */
function computeWindingConsistent(uses: readonly { from: CanonicalVertexId; to: CanonicalVertexId }[], a: CanonicalVertexId): boolean {
  let forward = 0; // a -> b
  let backward = 0; // b -> a
  for (const use of uses) {
    if (use.from === a) forward++;
    else backward++;
  }
  return forward <= 1 && backward <= 1;
}
