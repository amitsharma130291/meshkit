/**
 * Per-shell orientation analysis: whether a shell's triangles can be
 * consistently wound (propagated via a 2-coloring walk over its own
 * manifold edges), and — only when that holds AND the shell is closed —
 * whether its signed volume indicates an inward (flipped) or outward
 * orientation.
 *
 * Terminology this phase deliberately holds to (see the Phase 5 spec):
 * - Two triangles sharing a manifold edge (exactly 2 incident triangles)
 *   are wound consistently relative to each other when they traverse
 *   that edge in OPPOSITE directions — the normal, correct case for two
 *   adjacent faces of a properly oriented surface. Same-direction
 *   traversal is a winding conflict (`edge-incidence.ts`'s own
 *   `windingConsistent` flag).
 * - A shell is "consistently orientable" only when this relative
 *   constraint can be propagated across every manifold edge in the shell
 *   without contradiction (an odd cycle of winding conflicts makes this
 *   impossible — the classic non-orientable-surface signature). Only
 *   manifold edges participate in propagation; a non-manifold edge has no
 *   single well-defined "the other triangle" relation, so it neither
 *   confirms nor breaks orientability here (its own non-manifold-ness is
 *   already reported separately by `edge-incidence.ts`).
 * - For a CLOSED (zero boundary edges), consistently orientable shell
 *   with a non-negligible signed volume, the sign of that volume
 *   determines inward vs. outward. An open shell has no provable
 *   "inside" — its orientation consistency is still reported, but it is
 *   never labeled inward/outward.
 */
import { edgeKeyString, type CanonicalTriangle, type CanonicalVertexId, type EdgeRecord } from "./topology-types";

export type ShellOrientationVerdict = "outward" | "inward" | "indeterminate";

export interface ShellOrientationResult {
  shellId: number;
  consistentlyOrientable: boolean;
  closed: boolean;
  /** Signed volume via the origin-relative tetrahedron sum — translation-invariant for a genuinely closed surface (see module doc), meaningless (but still computed) for an open one. */
  signedVolume: number;
  verdict: ShellOrientationVerdict;
  /**
   * `triangleIndex -> 0|1` from the same BFS propagation used to compute
   * `consistentlyOrientable` — `0` means "already agrees with this
   * shell's own seed triangle," `1` means "would need to flip to agree."
   * `null` exactly when `consistentlyOrientable` is `false` (a
   * contradiction makes per-triangle parity meaningless). Diagnostics
   * reporting never needed this per-triangle detail, only the aggregate
   * boolean — `stl-repair/winding.ts` is what actually flips triangles
   * from it, reusing this exact propagation rather than re-deriving one.
   */
  parityByTriangleIndex: ReadonlyMap<number, 0 | 1> | null;
}

/**
 * Below this fraction of the shell's own bounding-box diagonal cubed, a
 * closed shell's signed volume is treated as too close to zero to trust
 * the sign of — e.g. a shell so thin or so small relative to the rest of
 * the model that floating-point cancellation could flip the sign. Scale-
 * aware (cubed, since volume scales with the cube of linear size), per
 * this phase's own "no bare global constant" requirement.
 */
const NEAR_ZERO_VOLUME_RATIO = 1e-9;

export function analyzeShellOrientation(
  shellId: number,
  triangleIndices: readonly number[],
  trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>,
  edgesByKey: ReadonlyMap<string, EdgeRecord>,
  vertices: Float32Array,
): ShellOrientationResult {
  const triangleIndexSet = new Set(triangleIndices);
  const propagation = propagateOrientation(triangleIndices, trianglesByIndex, edgesByKey, triangleIndexSet);
  const consistentlyOrientable = propagation.consistent;

  let boundaryEdgeCount = 0;
  for (const tri of triangleIndices) {
    const t = trianglesByIndex.get(tri)!;
    const [a, b, c] = t.vertexIds;
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const edge = edgesByKey.get(edgeKeyString(x, y))!;
      if (edge.edgeClass === "boundary") boundaryEdgeCount++;
    }
  }
  const closed = boundaryEdgeCount === 0;

  const signedVolume = computeSignedVolume(triangleIndices, trianglesByIndex, vertices);

  let verdict: ShellOrientationVerdict = "indeterminate";
  if (closed && consistentlyOrientable) {
    const diagonal = shellBoundsDiagonal(triangleIndices, trianglesByIndex, vertices);
    const threshold = diagonal > 0 ? NEAR_ZERO_VOLUME_RATIO * diagonal ** 3 : 0;
    if (Math.abs(signedVolume) > threshold) {
      verdict = signedVolume < 0 ? "inward" : "outward";
    }
  }

  return { shellId, consistentlyOrientable, closed, signedVolume, verdict, parityByTriangleIndex: consistentlyOrientable ? propagation.parity : null };
}

/**
 * BFS 2-coloring over the shell's own triangles, edges restricted to
 * manifold ones. `parity[t] = 0` means "same orientation as the seed
 * triangle as originally wound"; `1` means "would need to be flipped to
 * agree with the seed." A contradiction (a triangle reachable two ways
 * that disagree on parity) means the shell cannot be consistently
 * oriented. Iterative — never recursion — so a long triangle chain fails
 * safely via the shared edge-record ceiling, not a stack overflow.
 */
function propagateOrientation(
  triangleIndices: readonly number[],
  trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>,
  edgesByKey: ReadonlyMap<string, EdgeRecord>,
  triangleIndexSet: ReadonlySet<number>,
): { consistent: boolean; parity: Map<number, 0 | 1> } {
  const parity = new Map<number, 0 | 1>();
  for (const seed of triangleIndices) {
    if (parity.has(seed)) continue;
    parity.set(seed, 0);
    const queue: number[] = [seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentParity = parity.get(current)!;
      const t = trianglesByIndex.get(current)!;
      const [a, b, c] = t.vertexIds;
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        const edge = edgesByKey.get(edgeKeyString(x, y))!;
        if (edge.edgeClass !== "manifold") continue;
        const other = edge.uses.find((u) => u.triangleIndex !== current)?.triangleIndex;
        if (other === undefined || !triangleIndexSet.has(other)) continue;

        const mine = edge.uses.find((u) => u.triangleIndex === current)!;
        const theirs = edge.uses.find((u) => u.triangleIndex === other)!;
        // Opposite direction traversal = same intended orientation (parity unchanged); same direction = a flip relative to the seed.
        const sameDirection = mine.from === theirs.from;
        const expectedParity = (currentParity ^ (sameDirection ? 1 : 0)) as 0 | 1;

        const existing = parity.get(other);
        if (existing === undefined) {
          parity.set(other, expectedParity);
          queue.push(other);
        } else if (existing !== expectedParity) {
          return { consistent: false, parity };
        }
      }
    }
  }
  return { consistent: true, parity };
}

/**
 * Origin-relative signed tetrahedron sum: `Σ (v0 · (v1 × v2)) / 6` over
 * every triangle, using each triangle's ORIGINAL winding. For a genuinely
 * closed surface this is translation-invariant and equals the true
 * enclosed volume (the extra terms introduced by shifting the origin
 * cancel out over a closed surface) — verified directly by this module's
 * own "translated closed shell" test. For an open shell the number is
 * still computed (never withheld) but is not a true enclosed volume, and
 * `analyzeShellOrientation` never treats it as authoritative unless
 * `closed` is also true.
 */
function computeSignedVolume(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): number {
  let volume = 0;
  for (const idx of triangleIndices) {
    const t = trianglesByIndex.get(idx)!;
    const [ia, ib, ic] = t.vertexIds;
    const ax = vertices[ia * 3], ay = vertices[ia * 3 + 1], az = vertices[ia * 3 + 2];
    const bx = vertices[ib * 3], by = vertices[ib * 3 + 1], bz = vertices[ib * 3 + 2];
    const cx = vertices[ic * 3], cy = vertices[ic * 3 + 1], cz = vertices[ic * 3 + 2];
    // v0 . (v1 x v2)
    const cross_x = by * cz - bz * cy;
    const cross_y = bz * cx - bx * cz;
    const cross_z = bx * cy - by * cx;
    volume += ax * cross_x + ay * cross_y + az * cross_z;
  }
  return volume / 6;
}

function shellBoundsDiagonal(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const idx of triangleIndices) {
    const t = trianglesByIndex.get(idx)!;
    for (const vid of t.vertexIds) {
      const x = vertices[vid * 3], y = vertices[vid * 3 + 1], z = vertices[vid * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/** `CanonicalVertexId` re-exported only so callers importing `orientation.ts` for its result types don't need a second import from `topology-types.ts` just for this one alias. */
export type { CanonicalVertexId };
