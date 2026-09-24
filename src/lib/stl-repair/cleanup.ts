/**
 * Degenerate-triangle and duplicate-face removal — both built entirely
 * on Phase 5's own, unchanged classification (`canonical-vertices.ts`'s
 * degenerate list, `duplicate-faces.ts`'s identity/winding groups).
 * Neither function re-derives what counts as degenerate or duplicate;
 * each just decides, from that existing classification, which triangles
 * survive into the rebuilt position buffer.
 */
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { analyzeDuplicateFaces } from "../mesh/duplicate-faces";
import type { CanonicalTriangle } from "../mesh/topology-types";

export interface RemoveDegenerateOptions {
  removeExact: boolean;
  removeNearZero: boolean;
  isCancelled?: () => boolean;
}

export interface RemoveDegenerateResult {
  positions: Float32Array;
  repeatedVertexRemoved: number;
  exactZeroAreaRemoved: number;
  nearZeroAreaRemoved: number;
}

export async function removeDegenerateTriangles(positions: Float32Array, options: RemoveDegenerateOptions): Promise<RemoveDegenerateResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: Number.MAX_SAFE_INTEGER }, { isCancelled: options.isCancelled });

  let repeatedVertexRemoved = 0;
  let exactZeroAreaRemoved = 0;
  let nearZeroAreaRemoved = 0;
  const removedIndices = new Set<number>();

  for (const d of mesh.degenerate) {
    if (d.reason === "repeated-vertex") {
      if (!options.removeExact) continue;
      repeatedVertexRemoved++;
    } else if (d.reason === "zero-area") {
      if (!options.removeExact) continue;
      exactZeroAreaRemoved++;
    } else {
      if (!options.removeNearZero) continue;
      nearZeroAreaRemoved++;
    }
    removedIndices.add(d.index);
  }

  const survivors = mesh.triangles.filter((t) => !removedIndices.has(t.index));
  return {
    positions: rebuildFromTriangles(survivors, mesh.vertices),
    repeatedVertexRemoved,
    exactZeroAreaRemoved,
    nearZeroAreaRemoved,
  };
}

export interface RemoveDuplicateFacesResult {
  positions: Float32Array;
  groupCount: number;
  sameWindingRemoved: number;
  reverseWindingRemoved: number;
}

/**
 * Deterministic survivor policy: within each duplicate identity group,
 * the LOWEST-index triangle in each winding subgroup survives; every
 * other triangle in the group (same-winding copies beyond the first, and
 * — when a group contains both windings — every triangle from the
 * winding subgroup that isn't itself kept) is removed. When a group
 * contains BOTH windings, keeping one triangle from each would leave two
 * exactly opposite-facing coincident triangles (a physically meaningless
 * "zero-thickness shell" at that face) — this policy instead keeps only
 * the winding subgroup with the lower minimum triangle index (i.e.
 * whichever orientation appeared first in the file), removing the
 * other winding's triangles entirely, and the resulting topology is
 * verified afterward by re-running edge incidence in the caller's own
 * post-repair diagnostics, not assumed here.
 */
export async function removeDuplicateFaces(positions: Float32Array, options: { isCancelled?: () => boolean } = {}): Promise<RemoveDuplicateFacesResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: Number.MAX_SAFE_INTEGER }, { isCancelled: options.isCancelled });
  const duplicates = analyzeDuplicateFaces(mesh.validTriangles, { maxGroups: Number.MAX_SAFE_INTEGER, maxTriangleIndicesPerGroup: Number.MAX_SAFE_INTEGER });

  const removed = new Set<number>();
  let sameWindingRemoved = 0;
  let reverseWindingRemoved = 0;

  for (const group of duplicates.groups) {
    const hasBothWindings = group.sameWindingTriangleIndices.length > 0 && group.reverseWindingTriangleIndices.length > 0;
    if (hasBothWindings) {
      const minSame = Math.min(...group.sameWindingTriangleIndices);
      const minReverse = Math.min(...group.reverseWindingTriangleIndices);
      const keepSame = minSame < minReverse;
      const survivorBucket = keepSame ? group.sameWindingTriangleIndices : group.reverseWindingTriangleIndices;
      const removedBucket = keepSame ? group.reverseWindingTriangleIndices : group.sameWindingTriangleIndices;
      const survivor = Math.min(...survivorBucket);
      for (const idx of survivorBucket) {
        if (idx !== survivor) {
          removed.add(idx);
          sameWindingRemoved++;
        }
      }
      for (const idx of removedBucket) {
        removed.add(idx);
        reverseWindingRemoved++;
      }
    } else {
      const survivor = Math.min(...group.sameWindingTriangleIndices);
      for (const idx of group.sameWindingTriangleIndices) {
        if (idx !== survivor) {
          removed.add(idx);
          sameWindingRemoved++;
        }
      }
    }
  }

  const survivors = mesh.validTriangles.filter((t) => !removed.has(t.index));
  return { positions: rebuildFromTriangles(survivors, mesh.vertices), groupCount: duplicates.groups.length, sameWindingRemoved, reverseWindingRemoved };
}

function rebuildFromTriangles(triangles: readonly CanonicalTriangle[], vertices: Float32Array): Float32Array {
  const out = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const tri of triangles) {
    for (const v of tri.vertexIds) {
      out[offset++] = vertices[v * 3];
      out[offset++] = vertices[v * 3 + 1];
      out[offset++] = vertices[v * 3 + 2];
    }
  }
  return out;
}
