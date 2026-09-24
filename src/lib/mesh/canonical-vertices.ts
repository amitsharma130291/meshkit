/**
 * Builds the immutable topology layer over a flat, non-indexed triangle
 * buffer (STL's own native layout): exact-identity canonical vertex IDs,
 * per-triangle vertex-ID triples, and degenerate-triangle classification.
 * Every later stage (edge incidence, shells, orientation, duplicate
 * faces, self-intersection) is built on top of this one pass and never
 * re-derives vertex identity its own way.
 *
 * Vertex identity policy: exact float32 coordinate identity — the same
 * bit-pattern-keyed, `-0`-normalized exact match `deduplicateVertices()`
 * already implements for every converter's own indexed output. Reused
 * directly rather than re-implemented, so "same vertex" means the same
 * thing here as it does for every STL→OBJ/STL→3MF converter's own vertex
 * count. Deliberately NOT tolerance-welded: welding is a mesh-repair
 * decision (Phase 6), and silently applying one here would change which
 * edges are "shared" and could hide a real gap between two surfaces that
 * only looks closed after welding.
 */
import { deduplicateVertices, type DeduplicateOptions } from "./deduplicate";
import type { Bounds3, CanonicalTriangle, DegenerateReason, DegenerateTriangleInfo } from "./topology-types";

export interface CanonicalMeshLimits {
  maxUniqueVertices: number;
}

export interface CanonicalMesh {
  /** One entry per unique exact vertex position, in first-occurrence order — [x,y,z, x,y,z, ...]. */
  vertices: Float32Array;
  sourceVertexCount: number;
  uniqueVertexCount: number;
  /** `sourceVertexCount - uniqueVertexCount` — how many of the file's own per-triangle vertex slots reused an already-seen exact position. */
  duplicateCoordinateReferenceCount: number;
  triangleCount: number;
  /** Every triangle, canonicalized, in original file order — including degenerate ones (see `degenerate` for which and why). */
  triangles: CanonicalTriangle[];
  degenerate: DegenerateTriangleInfo[];
  /** `triangles` filtered to exclude every index present in `degenerate` — the input every downstream topology stage (edges, shells, orientation, duplicate faces, self-intersection) actually consumes. */
  validTriangles: CanonicalTriangle[];
  exactZeroAreaCount: number;
  nearZeroAreaCount: number;
  repeatedVertexCount: number;
  bounds: Bounds3;
}

/**
 * Relative to the mesh's own bounding-box diagonal (scale-aware, per this
 * phase's explicit requirement not to use a bare global constant): a
 * triangle whose area is smaller than `(NEAR_ZERO_AREA_RATIO * diagonal)^2`
 * but not exactly zero is "near-zero-area" rather than a legitimate sliver
 * of real geometry. `diagonal^2` (not `diagonal`) because area scales
 * quadratically with linear size — using a linear ratio directly against
 * area would make the threshold scale wrong for a much larger or smaller
 * model.
 */
const NEAR_ZERO_AREA_RATIO = 1e-6;

export async function buildCanonicalMesh(positions: Float32Array, limits: CanonicalMeshLimits, options: DeduplicateOptions = {}): Promise<CanonicalMesh> {
  const dedup = await deduplicateVertices(positions, { maxUniqueVertices: limits.maxUniqueVertices }, options);
  const triangleCount = dedup.triangleVertexIndices.length / 3;

  const triangles: CanonicalTriangle[] = new Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    triangles[t] = {
      index: t,
      vertexIds: [dedup.triangleVertexIndices[base], dedup.triangleVertexIndices[base + 1], dedup.triangleVertexIndices[base + 2]],
    };
  }

  const bounds = computeVertexBounds(dedup.vertices);
  const diagonal = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const nearZeroAreaThreshold = diagonal > 0 ? (NEAR_ZERO_AREA_RATIO * diagonal) ** 2 : 0;

  const degenerate: DegenerateTriangleInfo[] = [];
  let exactZeroAreaCount = 0;
  let nearZeroAreaCount = 0;
  let repeatedVertexCount = 0;

  for (const tri of triangles) {
    const reason = classifyTriangle(dedup.vertices, tri.vertexIds, nearZeroAreaThreshold);
    if (reason === null) continue;
    degenerate.push({ index: tri.index, reason });
    if (reason === "repeated-vertex") repeatedVertexCount++;
    else if (reason === "zero-area") exactZeroAreaCount++;
    else nearZeroAreaCount++;
  }

  const degenerateIndices = new Set(degenerate.map((d) => d.index));
  const validTriangles = triangles.filter((t) => !degenerateIndices.has(t.index));

  return {
    vertices: dedup.vertices,
    sourceVertexCount: dedup.sourceVertexCount,
    uniqueVertexCount: dedup.uniqueVertexCount,
    duplicateCoordinateReferenceCount: dedup.sourceVertexCount - dedup.uniqueVertexCount,
    triangleCount,
    triangles,
    degenerate,
    validTriangles,
    exactZeroAreaCount,
    nearZeroAreaCount,
    repeatedVertexCount,
    bounds,
  };
}

function classifyTriangle(vertices: Float32Array, ids: readonly [number, number, number], nearZeroAreaThreshold: number): DegenerateReason | null {
  const [ia, ib, ic] = ids;
  if (ia === ib || ib === ic || ia === ic) return "repeated-vertex";

  const area = triangleAreaSquared(vertices, ia, ib, ic);
  if (area === 0) return "zero-area";
  if (area < nearZeroAreaThreshold) return "near-zero-area";
  return null;
}

/** Squared area (4x the true area, squared) — avoids a `Math.sqrt` per triangle since every caller only ever compares this against another squared/pre-squared threshold. */
function triangleAreaSquared(vertices: Float32Array, ia: number, ib: number, ic: number): number {
  const ax = vertices[ia * 3];
  const ay = vertices[ia * 3 + 1];
  const az = vertices[ia * 3 + 2];
  const ux = vertices[ib * 3] - ax;
  const uy = vertices[ib * 3 + 1] - ay;
  const uz = vertices[ib * 3 + 2] - az;
  const vx = vertices[ic * 3] - ax;
  const vy = vertices[ic * 3 + 1] - ay;
  const vz = vertices[ic * 3 + 2] - az;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return (cx * cx + cy * cy + cz * cz) / 4;
}

function computeVertexBounds(vertices: Float32Array): Bounds3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
