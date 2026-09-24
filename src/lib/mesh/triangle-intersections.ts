/**
 * Self-intersection detection: a broad-phase spatial-grid pass
 * (`spatial-index.ts`) followed by a robust triangle-triangle narrow-phase
 * test (a Möller-style separating-plane test, with an explicit coplanar
 * fallback), applied only to candidate pairs that are NOT expected
 * manifold/topology adjacency.
 *
 * Exclusion policy (documented and tested):
 * - Two triangles sharing a topology EDGE (found via `edge-incidence.ts`,
 *   regardless of whether that edge is manifold or non-manifold) are
 *   ALWAYS excluded from narrow-phase testing — this is ordinary expected
 *   adjacency, never a self-intersection, per this phase's own
 *   requirement to exclude expected manifold adjacency.
 * - Two triangles sharing only a vertex (no shared edge) are NOT
 *   excluded — they go through the normal narrow-phase test, which
 *   correctly reports "no intersection" for simple point contact and
 *   still correctly detects genuine crossing for two otherwise-unrelated
 *   triangles that happen to touch at one shared vertex.
 * - Two triangles already identified as duplicate faces (`duplicate-
 *   faces.ts` — identical vertex identity, either winding) are excluded:
 *   that condition is already reported precisely under "duplicate
 *   faces," and re-flagging the exact same pair as a self-intersection
 *   (which a coplanar identical pair trivially would be) would just be
 *   the same finding under two different names.
 * - Degenerate triangles never reach this module at all — callers only
 *   ever pass `CanonicalMesh.validTriangles`.
 *
 * "Touching without crossing" (two triangles that share a single contact
 * point or a contact edge segment without any interior overlap) is never
 * flagged, via an explicit epsilon on both the plane-side test and the
 * final interval-overlap test — genuine floating-point-noise "barely
 * touching" is treated as non-intersecting, not as a false positive.
 */
import type { CanonicalTriangle, CanonicalVertexId, TriangleIndex } from "./topology-types";

type Vec3 = [number, number, number];

export interface TrianglePositions {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

function sub(u: Vec3, v: Vec3): Vec3 {
  return [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
}
function cross(u: Vec3, v: Vec3): Vec3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function dot(u: Vec3, v: Vec3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}
function lerp(u: Vec3, v: Vec3, t: number): Vec3 {
  return [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];
}

/**
 * `true` when the two triangles genuinely overlap in their interiors
 * (crossing), beyond `epsilon`. `epsilon` is an absolute distance,
 * derived by the caller from the whole mesh's own bounding-box diagonal
 * (scale-aware — see `analyzeSelfIntersections`), applied both to the
 * plane-side classification and to the final interval-overlap check.
 */
export function trianglesIntersect(t1: TrianglePositions, t2: TrianglePositions, epsilon: number): boolean {
  const n1 = cross(sub(t1.b, t1.a), sub(t1.c, t1.a));
  const d1 = -dot(n1, t1.a);
  const du = [dot(n1, t2.a) + d1, dot(n1, t2.b) + d1, dot(n1, t2.c) + d1] as const;

  const n2 = cross(sub(t2.b, t2.a), sub(t2.c, t2.a));
  const d2 = -dot(n2, t2.a);
  const dv = [dot(n2, t1.a) + d2, dot(n2, t1.b) + d2, dot(n2, t1.c) + d2] as const;

  const allSameSideU = sameSideBeyondEpsilon(du, epsilon);
  const allSameSideV = sameSideBeyondEpsilon(dv, epsilon);
  if (allSameSideU || allSameSideV) return false;

  const nearlyCoplanar = du.every((d) => Math.abs(d) <= epsilon) && dv.every((d) => Math.abs(d) <= epsilon);
  if (nearlyCoplanar) return coplanarTrianglesOverlap(t1, t2, n1, epsilon);

  const dLine = cross(n1, n2);
  const lineLenSq = dot(dLine, dLine);
  if (lineLenSq < epsilon * epsilon) return false; // parallel, non-coplanar planes never intersect

  const interval1 = triangleIntervalOnLine([t1.a, t1.b, t1.c], dv, dLine);
  const interval2 = triangleIntervalOnLine([t2.a, t2.b, t2.c], du, dLine);
  if (!interval1 || !interval2) return false;

  const lo = Math.max(interval1[0], interval2[0]);
  const hi = Math.min(interval1[1], interval2[1]);
  return hi - lo > epsilon;
}

function sameSideBeyondEpsilon(d: readonly [number, number, number], epsilon: number): boolean {
  const signs = d.map((v) => (v > epsilon ? 1 : v < -epsilon ? -1 : 0));
  const nonZero = signs.filter((s) => s !== 0);
  if (nonZero.length < 3) return false; // at least one vertex is on (or very near) the plane — can't rule out intersection this way
  return nonZero[0] === nonZero[1] && nonZero[1] === nonZero[2];
}

/**
 * The scalar-parameter interval, along `dLine`, where `triangle`'s
 * boundary crosses the OTHER triangle's plane — found from the two edges
 * that cross zero in `signedDistances` (the vertex alone on one side
 * contributes both crossing edges). Returns `null` only when every vertex
 * is (near-)exactly on the plane, an even more degenerate case the
 * coplanar path already handles.
 */
function triangleIntervalOnLine(vertices: readonly [Vec3, Vec3, Vec3], signedDistances: readonly [number, number, number], dLine: Vec3): [number, number] | null {
  const params: number[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = signedDistances[i];
    const dj = signedDistances[j];
    if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
      const t = di / (di - dj);
      params.push(dot(dLine, lerp(vertices[i], vertices[j], t)));
    } else if (di === 0) {
      params.push(dot(dLine, vertices[i]));
    }
  }
  if (params.length < 2) return null;
  const lo = Math.min(...params);
  const hi = Math.max(...params);
  return [lo, hi];
}

/** Coplanar overlap: projects both triangles onto their shared plane's dominant 2D axes, then a standard 2D triangle/triangle SAT-style overlap test (edge-crossing plus containment). */
function coplanarTrianglesOverlap(t1: TrianglePositions, t2: TrianglePositions, normal: Vec3, epsilon: number): boolean {
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  const axis: 0 | 1 | 2 = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const project = (v: Vec3): [number, number] => (axis === 0 ? [v[1], v[2]] : axis === 1 ? [v[2], v[0]] : [v[0], v[1]]);

  const p1: [number, number][] = [project(t1.a), project(t1.b), project(t1.c)];
  const p2: [number, number][] = [project(t2.a), project(t2.b), project(t2.c)];
  const eps2D = epsilon;

  for (let i = 0; i < 3; i++) {
    const a1 = p1[i], a2 = p1[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      const b1 = p2[j], b2 = p2[(j + 1) % 3];
      if (segmentsCrossStrictly(a1, a2, b1, b2, eps2D)) return true;
    }
  }
  if (pointStrictlyInTriangle(p1[0], p2, eps2D)) return true;
  if (pointStrictlyInTriangle(p2[0], p1, eps2D)) return true;
  // Full containment (including the fully-coincident/duplicate-triangle
  // case): every vertex of one triangle lies inside-OR-ON the other. This
  // is deliberately INCLUSIVE (unlike the strict single-point check
  // above) because two exactly coincident triangles have every vertex
  // sitting exactly on the other's boundary, never strictly inside —
  // edge-crossing never fires either, since coincident edges overlap
  // rather than cross. Ordinary shared-edge or shared-vertex-only
  // adjacency still correctly fails this (each triangle has at least one
  // vertex genuinely outside the other), so this adds no false positive
  // for expected adjacency.
  if (p1.every((p) => pointInOrOnTriangle(p, p2, eps2D)) || p2.every((p) => pointInOrOnTriangle(p, p1, eps2D))) return true;
  return false;
}

function pointInOrOnTriangle(p: [number, number], tri: [number, number][], eps: number): boolean {
  const [a, b, c] = tri;
  const d1 = cross2D(a, b, p);
  const d2 = cross2D(b, c, p);
  const d3 = cross2D(c, a, p);
  const hasNeg = d1 < -eps || d2 < -eps || d3 < -eps;
  const hasPos = d1 > eps || d2 > eps || d3 > eps;
  return !(hasNeg && hasPos);
}

function cross2D(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsCrossStrictly(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number], eps: number): boolean {
  const d1 = cross2D(p3, p4, p1);
  const d2 = cross2D(p3, p4, p2);
  const d3 = cross2D(p1, p2, p3);
  const d4 = cross2D(p1, p2, p4);
  const straddle1 = (d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps);
  const straddle2 = (d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps);
  return straddle1 && straddle2;
}

function pointStrictlyInTriangle(p: [number, number], tri: [number, number][], eps: number): boolean {
  const [a, b, c] = tri;
  const d1 = cross2D(a, b, p);
  const d2 = cross2D(b, c, p);
  const d3 = cross2D(c, a, p);
  const allPositive = d1 > eps && d2 > eps && d3 > eps;
  const allNegative = d1 < -eps && d2 < -eps && d3 < -eps;
  return allPositive || allNegative;
}

// --- Orchestration over a full mesh -----------------------------------

import type { EdgeRecord } from "./topology-types";
import { findCandidatePairs, type SpatialIndexLimits, type TriangleBox } from "./spatial-index";
import type { DuplicateFaceGroup } from "./duplicate-faces";
import { yieldIfCancelled } from "../cancellation";

export interface SelfIntersectionLimits extends SpatialIndexLimits {}

export interface SelfIntersectionPairSample {
  triangleA: TriangleIndex;
  triangleB: TriangleIndex;
}

export interface SelfIntersectionAnalysis {
  /** `"completed"` when the full candidate set was tested; `"not-checked"` when a safety ceiling was hit — NEVER reported as "no intersections" in that case. */
  status: "completed" | "not-checked";
  intersectingPairCount: number;
  /** Distinct triangle indices involved in at least one reported intersecting pair. */
  involvedTriangleCount: number;
  samplePairs: SelfIntersectionPairSample[];
}

export interface SelfIntersectionSampleLimits {
  maxSamplePairs: number;
}

export interface SelfIntersectionCancellationOptions {
  isCancelled?: () => boolean;
  /** How many candidate pairs to test between cancellation checks — see `cancellation.ts`. Tuned so ordinary-sized meshes never yield at all. */
  yieldEvery?: number;
}

const DEFAULT_YIELD_EVERY = 20_000;

/**
 * The narrow-phase pair-testing loop below is the one stage in the whole
 * diagnostics pipeline whose duration isn't already implicitly bounded by
 * an O(triangle count) pass — a mesh can legitimately have up to
 * `limits.maxCandidatePairs` candidate pairs to test — so this is the
 * one analysis stage with its own mid-loop cancellation support (`await
 * yieldIfCancelled`), not just cancellation between pipeline stages.
 */
export async function analyzeSelfIntersections(
  triangles: readonly CanonicalTriangle[],
  vertices: Float32Array,
  edgesByKey: ReadonlyMap<string, EdgeRecord>,
  duplicateGroups: readonly DuplicateFaceGroup[],
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  limits: SelfIntersectionLimits & SelfIntersectionSampleLimits,
  options: SelfIntersectionCancellationOptions = {},
): Promise<SelfIntersectionAnalysis> {
  if (triangles.length < 2) {
    return { status: "completed", intersectingPairCount: 0, involvedTriangleCount: 0, samplePairs: [] };
  }

  const trianglesByIndex = new Map(triangles.map((t) => [t.index, t]));
  const boxes: TriangleBox[] = triangles.map((t) => triangleBox(t, vertices));

  const excludedPairs = new Set<string>();
  for (const edge of edgesByKey.values()) {
    if (edge.uses.length < 2) continue;
    for (let i = 0; i < edge.uses.length; i++) {
      for (let j = i + 1; j < edge.uses.length; j++) {
        excludedPairs.add(pairKey(edge.uses[i].triangleIndex, edge.uses[j].triangleIndex));
      }
    }
  }
  for (const group of duplicateGroups) {
    const all = [...group.sameWindingTriangleIndices, ...group.reverseWindingTriangleIndices];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) excludedPairs.add(pairKey(all[i], all[j]));
    }
  }

  const diagonal = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const epsilon = diagonal > 0 ? diagonal * 1e-7 : 1e-7;

  let candidatePairs: [number, number][];
  try {
    candidatePairs = findCandidatePairs(boxes, limits);
  } catch {
    return { status: "not-checked", intersectingPairCount: 0, involvedTriangleCount: 0, samplePairs: [] };
  }

  let intersectingPairCount = 0;
  const involvedTriangles = new Set<number>();
  const samplePairs: SelfIntersectionPairSample[] = [];
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;

  for (let i = 0; i < candidatePairs.length; i++) {
    await yieldIfCancelled(i, yieldEvery, options.isCancelled);
    const [a, b] = candidatePairs[i];
    if (excludedPairs.has(pairKey(a, b))) continue;
    const triA = trianglesByIndex.get(a);
    const triB = trianglesByIndex.get(b);
    if (!triA || !triB) continue;
    if (trianglesIntersect(toPositions(triA, vertices), toPositions(triB, vertices), epsilon)) {
      intersectingPairCount++;
      involvedTriangles.add(a);
      involvedTriangles.add(b);
      if (samplePairs.length < limits.maxSamplePairs) samplePairs.push({ triangleA: a, triangleB: b });
    }
  }

  return { status: "completed", intersectingPairCount, involvedTriangleCount: involvedTriangles.size, samplePairs };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function toPositions(tri: CanonicalTriangle, vertices: Float32Array): TrianglePositions {
  const [ia, ib, ic] = tri.vertexIds;
  return {
    a: [vertices[ia * 3], vertices[ia * 3 + 1], vertices[ia * 3 + 2]],
    b: [vertices[ib * 3], vertices[ib * 3 + 1], vertices[ib * 3 + 2]],
    c: [vertices[ic * 3], vertices[ic * 3 + 1], vertices[ic * 3 + 2]],
  };
}

function triangleBox(tri: CanonicalTriangle, vertices: Float32Array): TriangleBox {
  const pos = toPositions(tri, vertices);
  const min: Vec3 = [Math.min(pos.a[0], pos.b[0], pos.c[0]), Math.min(pos.a[1], pos.b[1], pos.c[1]), Math.min(pos.a[2], pos.b[2], pos.c[2])];
  const max: Vec3 = [Math.max(pos.a[0], pos.b[0], pos.c[0]), Math.max(pos.a[1], pos.b[1], pos.c[1]), Math.max(pos.a[2], pos.b[2], pos.c[2])];
  return { triangleIndex: tri.index, min, max };
}

/** Re-exported so callers of this module's orchestration API don't need a second import just for this one alias. */
export type { CanonicalVertexId };
