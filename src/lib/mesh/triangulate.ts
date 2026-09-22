/**
 * Polygon triangulation for any polygon face with more than three
 * vertices. Unconditional fan triangulation corrupts concave polygons
 * (it can emit triangles that fall outside the polygon), so this module:
 *
 *   1. Returns a triangle face unchanged.
 *   2. Detects a convex polygon and fans it (O(n) — cheap and correct
 *      for convex input).
 *   3. Otherwise projects the polygon onto its dominant plane (via a
 *      Newell-method normal, so the projection is stable even for
 *      near-degenerate or slightly non-planar input) and ear-clips it.
 *
 * Every output triangle is expressed as an index triple into the INPUT
 * vertex list, in the input's own order — this is what makes winding
 * preservation automatic: nothing here ever reverses vertex order.
 *
 * Canonical, format-neutral home for this logic — moved here from
 * `src/lib/obj/` (where it originated during the OBJ writer's Phase 3B
 * implementation) once the PLY reader (Phase 3F) needed the identical
 * triangulation guarantee for its own polygon faces.
 * `src/lib/obj/triangulate.ts` now re-exports a thin, behavior-preserving
 * wrapper around this module — see that file's own comment for why a
 * wrapper (rather than a bare re-export) was necessary, mirroring the
 * `deduplicate.ts`/`number-format.ts` precedent from Phase 3E.
 */
import {
  FaceTooSmallError,
  PolygonDegenerateError,
  PolygonNonPlanarError,
  PolygonSelfIntersectingError,
  TriangulationFailedError,
} from "./errors";

export interface TriangulationResult {
  /** Index triples into the input polygon's local vertex list (0-based), preserving the input's winding. */
  triangles: [number, number, number][];
  /** True when the polygon deviated from planarity beyond the warn threshold but was still within the accepted tolerance. */
  nonPlanarWarning: boolean;
}

type Point2D = readonly [number, number];
type Point3D = readonly [number, number, number];

const EPS_2D_AREA = 1e-9;
const EPS_3D_LENGTH = 1e-12;
/** Relative to the polygon's own extent — see checkPlanarity(). Below this ratio, a deviation isn't worth mentioning. */
const PLANARITY_WARN_RATIO = 0.005;
/** Beyond this ratio, projecting the polygon to 2D would meaningfully distort it — fail safely instead of guessing. */
const PLANARITY_REJECT_RATIO = 0.05;

export function triangulatePolygon(vertices: Point3D[], maxIterations: number): TriangulationResult {
  const n = vertices.length;
  if (n < 3) throw new FaceTooSmallError();

  if (n === 3) {
    if (triangleArea3D(vertices[0], vertices[1], vertices[2]) < EPS_3D_LENGTH) {
      throw new PolygonDegenerateError();
    }
    return { triangles: [[0, 1, 2]], nonPlanarWarning: false };
  }

  // Newell's sum cancels to (near) zero not only for a genuinely degenerate
  // polygon but also for a self-intersecting one whose crossing loops wind
  // in opposite directions (a bowtie is the textbook case) — so a zero
  // Newell normal falls back to a single triangle's cross product before
  // concluding the polygon is degenerate. That fallback is only used to
  // pick a projection plane; the actual self-intersection/degeneracy
  // verdict is still decided by the 2D checks below.
  let normal = newellNormal(vertices);
  let normalLength = length3(normal);
  if (normalLength < EPS_3D_LENGTH) {
    normal = fallbackTripleNormal(vertices);
    normalLength = length3(normal);
  }
  if (normalLength < EPS_3D_LENGTH) throw new PolygonDegenerateError();
  const unitNormal: Point3D = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];

  const nonPlanarWarning = checkPlanarity(vertices, unitNormal);

  const axis = dominantAxis(unitNormal);
  const points2D = projectPolygon(vertices, axis);

  // Checked before the area/convexity tests deliberately: a self-crossing
  // polygon's positive and negative loops can cancel to a near-zero net
  // signed area (a classic "bowtie" does exactly this), which would
  // otherwise be misreported as degenerate instead of the more specific
  // self-intersecting.
  if (hasSelfIntersection(points2D)) throw new PolygonSelfIntersectingError();

  const area = signedArea2D(points2D);
  if (Math.abs(area) < EPS_2D_AREA) throw new PolygonDegenerateError();
  const orientation: 1 | -1 = area > 0 ? 1 : -1;

  if (isConvex(points2D, orientation)) {
    const triangles = fanTriangulate(points2D);
    if (triangles.length === 0) throw new PolygonDegenerateError();
    return { triangles, nonPlanarWarning };
  }

  return { triangles: earClip(points2D, orientation, maxIterations), nonPlanarWarning };
}

function triangleArea3D(a: Point3D, b: Point3D, c: Point3D): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

/** Newell's method: a stable polygon normal even when three arbitrary vertices would be collinear or near-degenerate. */
function newellNormal(vertices: Point3D[]): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1, z1] = vertices[i];
    const [x2, y2, z2] = vertices[(i + 1) % n];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}

function length3(v: Point3D): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** Cross product of the first non-collinear consecutive vertex triple found — see the Newell-cancellation comment above. */
function fallbackTripleNormal(vertices: Point3D[]): [number, number, number] {
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const c = vertices[(i + 2) % n];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz > EPS_3D_LENGTH * EPS_3D_LENGTH) return [nx, ny, nz];
  }
  return [0, 0, 0];
}

/**
 * Measures how far the polygon's vertices deviate from the plane through
 * their centroid with normal `unitNormal`, relative to the polygon's own
 * extent. Throws `PolygonNonPlanarError` beyond a "this would
 * meaningfully distort the geometry" ratio; returns whether a smaller,
 * still-accepted deviation is worth a non-blocking warning.
 */
function checkPlanarity(vertices: Point3D[], unitNormal: Point3D): boolean {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of vertices) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  const n = vertices.length;
  cx /= n;
  cy /= n;
  cz /= n;

  let maxDeviation = 0;
  let maxExtent = 0;
  for (const v of vertices) {
    const dx = v[0] - cx;
    const dy = v[1] - cy;
    const dz = v[2] - cz;
    const deviation = Math.abs(dx * unitNormal[0] + dy * unitNormal[1] + dz * unitNormal[2]);
    if (deviation > maxDeviation) maxDeviation = deviation;
    const extent = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (extent > maxExtent) maxExtent = extent;
  }

  if (maxExtent < EPS_3D_LENGTH) return false; // vanishingly small polygon — degeneracy is handled elsewhere
  const ratio = maxDeviation / maxExtent;
  if (ratio > PLANARITY_REJECT_RATIO) throw new PolygonNonPlanarError();
  return ratio > PLANARITY_WARN_RATIO;
}

function dominantAxis(normal: Point3D): 0 | 1 | 2 {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

/** Drops the dominant axis, projecting onto the other two in a fixed cyclic order (x→y→z→x). Orientation is read back from the resulting 2D signed area, not assumed. */
function projectPolygon(vertices: Point3D[], axis: 0 | 1 | 2): Point2D[] {
  return vertices.map((v): Point2D => {
    if (axis === 0) return [v[1], v[2]];
    if (axis === 1) return [v[2], v[0]];
    return [v[0], v[1]];
  });
}

function signedArea2D(points: Point2D[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Twice the signed area of triangle (o, a, b) — positive when a→b turns counter-clockwise around o. */
function cross2D(o: Point2D, a: Point2D, b: Point2D): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function isConvex(points: Point2D[], orientation: 1 | -1): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    if (cross2D(prev, curr, next) * orientation < -EPS_2D_AREA) return false; // a reflex vertex
  }
  return true;
}

function fanTriangulate(points: Point2D[]): [number, number, number][] {
  const triangles: [number, number, number][] = [];
  for (let i = 1; i < points.length - 1; i++) {
    if (Math.abs(cross2D(points[0], points[i], points[i + 1])) > EPS_2D_AREA) {
      triangles.push([0, i, i + 1]);
    }
  }
  return triangles;
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = cross2D(a, b, p);
  const d2 = cross2D(b, c, p);
  const d3 = cross2D(c, a, p);
  const hasNeg = d1 < -EPS_2D_AREA || d2 < -EPS_2D_AREA || d3 < -EPS_2D_AREA;
  const hasPos = d1 > EPS_2D_AREA || d2 > EPS_2D_AREA || d3 > EPS_2D_AREA;
  return !(hasNeg && hasPos);
}

function segmentsIntersect(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): boolean {
  const d1 = cross2D(p3, p4, p1);
  const d2 = cross2D(p3, p4, p2);
  const d3 = cross2D(p1, p2, p3);
  const d4 = cross2D(p1, p2, p4);
  const straddle1 = (d1 > EPS_2D_AREA && d2 < -EPS_2D_AREA) || (d1 < -EPS_2D_AREA && d2 > EPS_2D_AREA);
  const straddle2 = (d3 > EPS_2D_AREA && d4 < -EPS_2D_AREA) || (d3 < -EPS_2D_AREA && d4 > EPS_2D_AREA);
  return straddle1 && straddle2;
}

/** O(n^2) check over non-adjacent edge pairs. Shared-vertex (adjacent) edges are never flagged — touching at a shared polygon vertex is normal, not a self-intersection. */
function hasSelfIntersection(points: Point2D[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // adjacent or identical edge
      if (segmentsIntersect(a1, a2, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Standard ear-clipping: repeatedly finds a convex vertex (relative to the
 * polygon's overall orientation) whose ear triangle contains no other
 * remaining polygon vertex, emits it, and removes that vertex — until
 * three remain. Deterministic (always scans from the current start),
 * winding-preserving (index triples reference the original point order)
 * and bounded by `maxIterations` so a pathological/pre-corrupted input
 * fails safely instead of looping indefinitely.
 */
function earClip(points: Point2D[], orientation: 1 | -1, maxIterations: number): [number, number, number][] {
  const indices = Array.from({ length: points.length }, (_, i) => i);
  const triangles: [number, number, number][] = [];
  let iterations = 0;

  while (indices.length > 3) {
    if (iterations++ >= maxIterations) throw new TriangulationFailedError();

    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const prevI = indices[(i - 1 + indices.length) % indices.length];
      const currI = indices[i];
      const nextI = indices[(i + 1) % indices.length];
      const prev = points[prevI];
      const curr = points[currI];
      const next = points[nextI];

      if (cross2D(prev, curr, next) * orientation <= EPS_2D_AREA) continue; // reflex or collinear — not a valid ear tip

      let isEar = true;
      for (const idx of indices) {
        if (idx === prevI || idx === currI || idx === nextI) continue;
        if (pointInTriangle(points[idx], prev, curr, next)) {
          isEar = false;
          break;
        }
      }

      if (isEar) {
        triangles.push([prevI, currI, nextI]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }

    // Every simple (non-self-intersecting) polygon has at least one ear;
    // reaching here means clipping got stuck despite the earlier explicit
    // self-intersection check — fail safely rather than emit bad geometry.
    if (!earFound) throw new TriangulationFailedError();
  }

  triangles.push([indices[0], indices[1], indices[2]]);
  return triangles;
}
