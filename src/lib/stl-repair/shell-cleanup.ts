/**
 * Optional, explicit small-shell removal — built on Phase 5's own
 * `connected-components.ts` shell resolution. NEVER runs unless
 * explicitly enabled (the caller's `RepairSettings.removeSmallShells.
 * enabled`); Safe mode never enables it, and Standard/Custom only do so
 * when the user opts in — this module has no default-on behavior of its
 * own and never assumes the largest shell is the "real" one on the
 * caller's behalf.
 */
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import type { CanonicalTriangle } from "../mesh/topology-types";
import type { SmallShellCriterion } from "./types";

export interface ShellCleanupOptions {
  criterion: SmallShellCriterion;
  threshold: number;
  maxShellsConsidered: number;
  isCancelled?: () => boolean;
}

export interface RemovedShellSummary {
  shellId: number;
  triangleCount: number;
}

export interface ShellCleanupResult {
  positions: Float32Array;
  shellCountBefore: number;
  candidateShellCount: number;
  shellsRemoved: RemovedShellSummary[];
  trianglesRemoved: number;
  /** Flat per-corner positions (9 floats/triangle) of every removed shell's own triangles — for the "removed shells" overlay. */
  removedPositions: Float32Array;
}

export async function removeSmallShells(positions: Float32Array, options: ShellCleanupOptions): Promise<ShellCleanupResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: Number.MAX_SAFE_INTEGER }, { isCancelled: options.isCancelled });
  const edgeIncidence = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: Number.MAX_SAFE_INTEGER });
  const shells = resolveTriangleShells(mesh.validTriangles, edgeIncidence.edgesByKey);
  const trianglesByIndex = new Map(mesh.validTriangles.map((t) => [t.index, t]));

  const shellStats = shells.triangleIndicesByShell.slice(0, options.maxShellsConsidered).map((triIndices, shellId) => ({
    shellId,
    triangleCount: triIndices.length,
    surfaceArea: shellSurfaceArea(triIndices, trianglesByIndex, mesh.vertices),
    diagonal: shellBoundsDiagonal(triIndices, trianglesByIndex, mesh.vertices),
  }));

  const largestArea = Math.max(...shellStats.map((s) => s.surfaceArea), 0);

  const toRemove = new Set<number>();
  for (const s of shellStats) {
    const isSmall =
      options.criterion === "triangle-count"
        ? s.triangleCount <= options.threshold
        : options.criterion === "relative-area"
          ? largestArea > 0 && s.surfaceArea / largestArea <= options.threshold
          : s.diagonal <= options.threshold;
    if (isSmall) toRemove.add(s.shellId);
  }

  // Never remove EVERY shell — if the threshold is set so broadly that
  // all shells qualify, that's a user-configuration outcome worth
  // surfacing (the caller reports `shellsRemoved`), but repair must
  // never emit a fully empty mesh; the single largest shell always
  // survives.
  if (toRemove.size === shellStats.length && shellStats.length > 0) {
    const largest = shellStats.reduce((a, b) => (b.triangleCount > a.triangleCount ? b : a));
    toRemove.delete(largest.shellId);
  }

  const shellsRemoved: RemovedShellSummary[] = [];
  let trianglesRemoved = 0;
  const survivors: CanonicalTriangle[] = [];
  const removed: CanonicalTriangle[] = [];
  shells.triangleIndicesByShell.forEach((triIndices, shellId) => {
    if (toRemove.has(shellId)) {
      shellsRemoved.push({ shellId, triangleCount: triIndices.length });
      trianglesRemoved += triIndices.length;
      for (const idx of triIndices) removed.push(trianglesByIndex.get(idx)!);
      return;
    }
    for (const idx of triIndices) survivors.push(trianglesByIndex.get(idx)!);
  });

  return {
    positions: rebuildFromTriangles(survivors, mesh.vertices),
    shellCountBefore: shells.shellCount,
    candidateShellCount: shellStats.length,
    shellsRemoved,
    trianglesRemoved,
    removedPositions: rebuildFromTriangles(removed, mesh.vertices),
  };
}

function shellSurfaceArea(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): number {
  let area = 0;
  for (const idx of triangleIndices) {
    const tri = trianglesByIndex.get(idx)!;
    const [ia, ib, ic] = tri.vertexIds;
    const ax = vertices[ia * 3], ay = vertices[ia * 3 + 1], az = vertices[ia * 3 + 2];
    const ux = vertices[ib * 3] - ax, uy = vertices[ib * 3 + 1] - ay, uz = vertices[ib * 3 + 2] - az;
    const vx = vertices[ic * 3] - ax, vy = vertices[ic * 3 + 1] - ay, vz = vertices[ic * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return area;
}

function shellBoundsDiagonal(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const idx of triangleIndices) {
    const tri = trianglesByIndex.get(idx)!;
    for (const vid of tri.vertexIds) {
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
