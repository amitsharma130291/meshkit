/**
 * Builds the bounded before/after visualization overlays. Two different
 * strategies, chosen per category for precision:
 *
 * - "Filled hole" and "removed shell" triangles are captured PRECISELY
 *   at the moment they're produced (hole-filling always APPENDS its new
 *   triangles to the end of the buffer; shell-cleanup already returns
 *   its own removed triangles' positions directly) — no diffing needed.
 * - "Removed" and "flipped" triangles, and "welded" vertices, are
 *   derived by comparing an unordered per-triangle position-key snapshot
 *   before and after the relevant stages — a triangle present before but
 *   absent after (by its 3 positions, order-independent) was removed; a
 *   triangle present in both but with different CORNER ORDER was
 *   flipped; a unique vertex position present before but absent after
 *   was welded away. This is a disclosed simplification: it reports
 *   WHAT changed precisely, without separately attributing removed
 *   triangles to "degenerate" vs "duplicate" vs "collapsed by welding"
 *   in the overlay geometry itself (the numeric counts elsewhere in the
 *   report already make that distinction; the overlay is for visual
 *   highlighting, not category attribution).
 * - "Unresolved" boundary/non-manifold/self-intersection overlays are
 *   reused directly from the AFTER diagnostics report's own overlay
 *   buffers (`stl-diagnostics/analyze.ts` already computes exactly these
 *   categories for whatever mesh it's given) — never recomputed here.
 */
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";
import type { RepairOverlayBuffers } from "./types";

export interface OverlaySnapshots {
  originalPositions: Float32Array;
  positionsAfterCleanup: Float32Array;
  positionsBeforeWinding: Float32Array;
  positionsAfterWinding: Float32Array;
  holeFillPatchPositions: Float32Array;
  removedShellPositions: Float32Array;
}

function triangleKey(positions: Float32Array, base: number): string {
  const pts: [number, number, number][] = [
    [positions[base], positions[base + 1], positions[base + 2]],
    [positions[base + 3], positions[base + 4], positions[base + 5]],
    [positions[base + 6], positions[base + 7], positions[base + 8]],
  ];
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return sorted.map((p) => p.map((v) => v.toFixed(6)).join(",")).join("|");
}

function orderedKey(positions: Float32Array, base: number): string {
  const pts: [number, number, number][] = [
    [positions[base], positions[base + 1], positions[base + 2]],
    [positions[base + 3], positions[base + 4], positions[base + 5]],
    [positions[base + 6], positions[base + 7], positions[base + 8]],
  ];
  return pts.map((p) => p.map((v) => v.toFixed(6)).join(",")).join("|");
}

function diffTriangles(before: Float32Array, after: Float32Array, cap: number): { removed: number[]; flipped: number[]; truncatedRemoved: boolean; truncatedFlipped: boolean } {
  const afterByKey = new Map<string, Set<string>>(); // unordered key -> set of ordered keys present after
  for (let i = 0; i < after.length; i += 9) {
    const uk = triangleKey(after, i);
    const ok = orderedKey(after, i);
    if (!afterByKey.has(uk)) afterByKey.set(uk, new Set());
    afterByKey.get(uk)!.add(ok);
  }

  const removed: number[] = [];
  const flipped: number[] = [];
  let truncatedRemoved = false;
  let truncatedFlipped = false;

  for (let i = 0; i < before.length; i += 9) {
    const uk = triangleKey(before, i);
    const ok = orderedKey(before, i);
    const afterOrdered = afterByKey.get(uk);
    if (!afterOrdered) {
      if (removed.length / 9 >= cap) truncatedRemoved = true;
      else removed.push(...before.subarray(i, i + 9));
    } else if (!afterOrdered.has(ok)) {
      if (flipped.length / 9 >= cap) truncatedFlipped = true;
      else flipped.push(...before.subarray(i, i + 9));
    }
  }

  return { removed, flipped, truncatedRemoved, truncatedFlipped };
}

function diffWeldedVertices(before: Float32Array, after: Float32Array, cap: number): { welded: number[]; truncated: boolean } {
  const afterSet = new Set<string>();
  for (let i = 0; i < after.length; i += 3) afterSet.add(`${after[i].toFixed(6)},${after[i + 1].toFixed(6)},${after[i + 2].toFixed(6)}`);

  const seenBefore = new Set<string>();
  const welded: number[] = [];
  let truncated = false;
  for (let i = 0; i < before.length; i += 3) {
    const key = `${before[i].toFixed(6)},${before[i + 1].toFixed(6)},${before[i + 2].toFixed(6)}`;
    if (seenBefore.has(key) || afterSet.has(key)) continue;
    seenBefore.add(key);
    if (welded.length / 3 >= cap) {
      truncated = true;
      continue;
    }
    welded.push(before[i], before[i + 1], before[i + 2]);
  }
  return { welded, truncated };
}

export function buildRepairOverlayBuffers(snapshots: OverlaySnapshots, afterDiagnostics: STLDiagnosticsReport, cap: number): RepairOverlayBuffers {
  const cleanupDiff = diffTriangles(snapshots.originalPositions, snapshots.positionsAfterCleanup, cap);
  const windingDiff = diffTriangles(snapshots.positionsBeforeWinding, snapshots.positionsAfterWinding, cap);
  const weldDiff = diffWeldedVertices(snapshots.originalPositions, snapshots.positionsAfterCleanup, cap);

  return {
    removedTrianglePositions: Float32Array.from(cleanupDiff.removed),
    flippedTrianglePositions: Float32Array.from(windingDiff.flipped),
    weldedVertexPositions: Float32Array.from(weldDiff.welded),
    filledHolePositions: capTriangles(snapshots.holeFillPatchPositions, cap),
    removedShellPositions: capTriangles(snapshots.removedShellPositions, cap),
    unresolvedBoundaryEdgeLines: afterDiagnostics.overlays.boundaryEdgeLines,
    unresolvedNonManifoldEdgeLines: afterDiagnostics.overlays.nonManifoldEdgeLines,
    unresolvedSelfIntersectionPositions: afterDiagnostics.overlays.selfIntersectingTrianglePositions,
    truncated: {
      removedTriangles: cleanupDiff.truncatedRemoved,
      flippedTriangles: windingDiff.truncatedFlipped,
      weldedVertices: weldDiff.truncated,
      filledHoles: snapshots.holeFillPatchPositions.length / 9 > cap,
      removedShells: snapshots.removedShellPositions.length / 9 > cap,
      unresolvedBoundary: afterDiagnostics.overlays.truncated.boundaryEdgeLines,
      unresolvedNonManifold: afterDiagnostics.overlays.truncated.nonManifoldEdgeLines,
      unresolvedSelfIntersections: afterDiagnostics.overlays.truncated.selfIntersectingTriangles,
    },
  };
}

function capTriangles(positions: Float32Array, cap: number): Float32Array {
  const maxFloats = cap * 9;
  return positions.length > maxFloats ? positions.slice(0, maxFloats) : positions;
}
