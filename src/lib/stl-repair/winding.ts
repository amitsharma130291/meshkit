/**
 * Winding correction and outward orientation — built entirely on Phase
 * 5's own `orientation.ts` propagation (the exact same BFS 2-coloring,
 * now also exposing its own per-triangle parity map for this module to
 * act on) and signed-volume verdict. This module makes no separate
 * orientability decision of its own.
 *
 * Per shell:
 * - Not consistently orientable (a contradiction — an odd cycle of
 *   winding conflicts): the shell is left COMPLETELY UNCHANGED and
 *   counted as unresolved. Never guessed at.
 * - Consistently orientable: every triangle whose parity disagrees with
 *   the shell's own seed triangle is flipped (vertex order reversed),
 *   making the shell internally consistent — this always happens,
 *   whether the shell is open or closed.
 * - Additionally, closed + consistently orientable + verdict `"inward"`
 *   (when `orientOutwardClosedShells` is requested): the ENTIRE shell is
 *   also reversed on top of the internal-consistency pass, via one XOR
 *   against each triangle's own flip decision — equivalent to flipping
 *   every triangle once more, but computed as a single pass. An OPEN
 *   shell is never globally reversed this way, since it has no provable
 *   "outward" to orient toward (Phase 5's own orientation verdict is
 *   never `"inward"`/`"outward"` for an open shell either).
 */
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import { analyzeShellOrientation } from "../mesh/orientation";
import type { CanonicalTriangle } from "../mesh/topology-types";

export interface WindingCorrectionOptions {
  orientOutwardClosedShells: boolean;
  isCancelled?: () => boolean;
}

export interface WindingCorrectionResult {
  positions: Float32Array;
  trianglesFlipped: number;
  shellsReversed: number;
  unresolvedShellCount: number;
}

export async function correctWinding(positions: Float32Array, options: WindingCorrectionOptions): Promise<WindingCorrectionResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: Number.MAX_SAFE_INTEGER }, { isCancelled: options.isCancelled });
  const edgeIncidence = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: Number.MAX_SAFE_INTEGER });
  const shells = resolveTriangleShells(mesh.validTriangles, edgeIncidence.edgesByKey);
  const trianglesByIndex = new Map(mesh.validTriangles.map((t) => [t.index, t]));

  const flipDecision = new Map<number, boolean>();
  let trianglesFlipped = 0;
  let shellsReversed = 0;
  let unresolvedShellCount = 0;

  for (let shellId = 0; shellId < shells.shellCount; shellId++) {
    const triangleIndices = shells.triangleIndicesByShell[shellId];
    const orientation = analyzeShellOrientation(shellId, triangleIndices, trianglesByIndex, edgeIncidence.edgesByKey, mesh.vertices);

    if (!orientation.consistentlyOrientable || !orientation.parityByTriangleIndex) {
      unresolvedShellCount++;
      for (const idx of triangleIndices) flipDecision.set(idx, false);
      continue;
    }

    const globalFlip = options.orientOutwardClosedShells && orientation.closed && orientation.verdict === "inward";
    if (globalFlip) shellsReversed++;

    for (const idx of triangleIndices) {
      const parity = orientation.parityByTriangleIndex.get(idx) ?? 0;
      const flip = (parity === 1) !== globalFlip;
      flipDecision.set(idx, flip);
      if (flip) trianglesFlipped++;
    }
  }

  const outPositions = new Float32Array(mesh.validTriangles.length * 9);
  let offset = 0;
  for (const tri of mesh.validTriangles) {
    const flip = flipDecision.get(tri.index) ?? false;
    const [a, b, c] = tri.vertexIds;
    const order = flip ? [a, c, b] : [a, b, c];
    for (const v of order) {
      outPositions[offset++] = mesh.vertices[v * 3];
      outPositions[offset++] = mesh.vertices[v * 3 + 1];
      outPositions[offset++] = mesh.vertices[v * 3 + 2];
    }
  }

  return { positions: outPositions, trianglesFlipped, shellsReversed, unresolvedShellCount };
}

/** Re-exported only for this module's own tests, which verify against the same triangle type the pipeline works with. */
export type { CanonicalTriangle };
