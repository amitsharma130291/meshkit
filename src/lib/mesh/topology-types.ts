/**
 * Shared vocabulary for the format-neutral triangle-soup topology layer
 * (`canonical-vertices.ts`, `edge-incidence.ts`, `connected-components.ts`,
 * `boundary-components.ts`, `orientation.ts`, `duplicate-faces.ts`,
 * `triangle-intersections.ts`, `spatial-index.ts`). Every module here
 * operates on a flat, non-indexed `Float32Array` of triangle corner
 * positions (9 floats per triangle — STL's own native layout, and the
 * same layout every other format's reader already produces before any
 * viewer-specific indexing), plus the canonical per-corner vertex IDs
 * `canonical-vertices.ts` derives from it. Nothing here is STL-specific;
 * `src/lib/stl-diagnostics/` is the STL-specific orchestration layer that
 * calls into this one.
 */

/** 0-based ID into a mesh's unique, exact-identity vertex position list — see `canonical-vertices.ts`. */
export type CanonicalVertexId = number;

/** 0-based triangle index into the original flat position buffer (`positions.subarray(i * 9, i * 9 + 9)`). */
export type TriangleIndex = number;

/**
 * A canonicalized triangle: its 3 corner positions collapsed to canonical
 * vertex IDs, in the triangle's ORIGINAL winding order — winding order is
 * never normalized away here, since orientation/winding-conflict analysis
 * depends on it.
 */
export interface CanonicalTriangle {
  index: TriangleIndex;
  vertexIds: [CanonicalVertexId, CanonicalVertexId, CanonicalVertexId];
}

/** Why a triangle is excluded from edge/shell/orientation/self-intersection analysis — see `classifyDegenerateTriangles()`. */
export type DegenerateReason = "repeated-vertex" | "zero-area" | "near-zero-area";

export interface DegenerateTriangleInfo {
  index: TriangleIndex;
  reason: DegenerateReason;
}

/** An unordered pair of canonical vertex IDs identifying one triangle edge, independent of which triangle or direction reports it. */
export interface EdgeKey {
  a: CanonicalVertexId;
  b: CanonicalVertexId;
}

/** Deterministic string key for `EdgeKey`, used as a `Map` key — `min_max`, so `(a,b)` and `(b,a)` always collide. */
export function edgeKeyString(a: CanonicalVertexId, b: CanonicalVertexId): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** One triangle's directed traversal of one of its edges, in the triangle's own winding order (`from` precedes `to` around the triangle). */
export interface DirectedEdgeUse {
  triangleIndex: TriangleIndex;
  from: CanonicalVertexId;
  to: CanonicalVertexId;
}

export type EdgeClass = "boundary" | "manifold" | "non-manifold";

export interface EdgeRecord {
  key: string;
  a: CanonicalVertexId;
  b: CanonicalVertexId;
  uses: DirectedEdgeUse[];
  edgeClass: EdgeClass;
  /**
   * `false` only when two or more directed uses traverse this edge in the
   * SAME direction (both `a→b` or both `b→a`) — the precise, documented
   * "inconsistent winding" definition this phase uses. Always `true` for a
   * boundary edge (a single use can't conflict with itself).
   */
   windingConsistent: boolean;
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}
