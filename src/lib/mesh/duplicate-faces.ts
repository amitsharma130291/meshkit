/**
 * Groups VALID (non-degenerate — see `canonical-vertices.ts`) triangles
 * by their canonical 3-vertex identity, independent of winding, then
 * splits each group by winding to distinguish same-winding from
 * reverse-winding duplicates. Two triangles that merely share an EDGE
 * (2 of 3 vertices) always land in different identity groups — a
 * triangle's full 3-vertex identity is what's compared, so ordinary
 * shared-edge adjacency is never mistaken for a duplicate face.
 *
 * A triangle's 3 vertex IDs admit exactly two possible cyclic windings
 * (e.g. `(a,b,c)` and its reverse `(a,c,b)`); canonicalizing to "start
 * from the smallest ID, keep the original cyclic order" collapses all 3
 * rotations of one winding to a single key, so within an identity group
 * there are at most 2 distinct winding keys.
 */
import type { CanonicalTriangle, CanonicalVertexId, TriangleIndex } from "./topology-types";

export interface DuplicateFaceGroup {
  vertexIds: [CanonicalVertexId, CanonicalVertexId, CanonicalVertexId];
  sameWindingTriangleIndices: TriangleIndex[];
  reverseWindingTriangleIndices: TriangleIndex[];
}

export interface DuplicateFaceAnalysis {
  /** Only identity groups with more than one triangle — i.e. genuine duplicates. Bounded by `limits.maxGroups`. */
  groups: DuplicateFaceGroup[];
  /** Redundant same-oriented copies: `sum(max(0, sameWindingCount - 1))` across every group, including ones beyond the retained sample. */
  sameWindingDuplicateFaceCount: number;
  /**
   * For every identity group containing BOTH winding directions, the
   * count on the smaller side — each of those triangles has at least one
   * genuine reverse-winding counterpart. (Documented, deliberately
   * conservative choice: this undercounts when one side has many more
   * copies than the other, rather than reporting every combinatorial
   * pair, consistent with this phase's "report groups and counts, not
   * exhaustive pairs" requirement.)
   */
  reverseWindingDuplicateFaceCount: number;
  /** True groups found may exceed `groups.length` when `limits.maxGroups` truncated the retained sample. */
  truncated: boolean;
}

export interface DuplicateFaceLimits {
  maxGroups: number;
  maxTriangleIndicesPerGroup: number;
}

interface WorkingGroup {
  vertexIds: [CanonicalVertexId, CanonicalVertexId, CanonicalVertexId];
  byWindingKey: Map<string, TriangleIndex[]>;
}

export function analyzeDuplicateFaces(triangles: readonly CanonicalTriangle[], limits: DuplicateFaceLimits): DuplicateFaceAnalysis {
  const groupsByIdentity = new Map<string, WorkingGroup>();

  for (const tri of triangles) {
    const [a, b, c] = tri.vertexIds;
    const sorted: [CanonicalVertexId, CanonicalVertexId, CanonicalVertexId] = [a, b, c].sort((x, y) => x - y) as [number, number, number];
    const identityKey = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
    const windingKey = canonicalWindingKey(a, b, c);

    let group = groupsByIdentity.get(identityKey);
    if (!group) {
      group = { vertexIds: sorted, byWindingKey: new Map() };
      groupsByIdentity.set(identityKey, group);
    }
    let bucket = group.byWindingKey.get(windingKey);
    if (!bucket) {
      bucket = [];
      group.byWindingKey.set(windingKey, bucket);
    }
    bucket.push(tri.index);
  }

  const groups: DuplicateFaceGroup[] = [];
  let sameWindingDuplicateFaceCount = 0;
  let reverseWindingDuplicateFaceCount = 0;
  let truncated = false;

  for (const group of groupsByIdentity.values()) {
    const buckets = [...group.byWindingKey.values()];
    const groupTotal = buckets.reduce((sum, b) => sum + b.length, 0);
    if (groupTotal < 2) continue; // a single-triangle identity group is not a duplicate at all

    for (const bucket of buckets) {
      if (bucket.length > 1) sameWindingDuplicateFaceCount += bucket.length - 1;
    }
    if (buckets.length === 2) {
      reverseWindingDuplicateFaceCount += Math.min(buckets[0].length, buckets[1].length);
    }

    if (groups.length >= limits.maxGroups) {
      truncated = true;
      continue;
    }
    const [bucketA, bucketB = []] = buckets;
    groups.push({
      vertexIds: group.vertexIds,
      sameWindingTriangleIndices: bucketA.slice(0, limits.maxTriangleIndicesPerGroup),
      reverseWindingTriangleIndices: buckets.length === 2 ? bucketB.slice(0, limits.maxTriangleIndicesPerGroup) : [],
    });
  }

  return { groups, sameWindingDuplicateFaceCount, reverseWindingDuplicateFaceCount, truncated };
}

/** Rotates `(a,b,c)` so the smallest ID comes first, preserving the original cyclic (winding) order — never sorted, since sorting would destroy winding. */
function canonicalWindingKey(a: CanonicalVertexId, b: CanonicalVertexId, c: CanonicalVertexId): string {
  if (a <= b && a <= c) return `${a}_${b}_${c}`;
  if (b <= a && b <= c) return `${b}_${c}_${a}`;
  return `${c}_${a}_${b}`;
}
