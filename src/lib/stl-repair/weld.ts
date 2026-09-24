/**
 * Tolerance-based vertex welding — the one repair operation Phase 5's
 * own exact-identity policy explicitly excluded. Operates on top of
 * `mesh/canonical-vertices.ts`'s EXACT-identity unique vertex list (never
 * re-deriving vertex identity its own way): welding only ever merges
 * positions that are already known to be distinct-but-close, via a
 * uniform spatial grid keyed by `toleranceAbs` (never an all-pairs scan)
 * and the exact same iterative union-find `mesh/connected-components.ts`
 * uses for shell resolution.
 *
 * Deterministic representative selection: the LOWEST canonical vertex ID
 * in each merged cluster becomes the representative position — never an
 * average, which would move geometry and make the operation's effect
 * harder to reason about or test. Canonical IDs are assigned in
 * first-occurrence order by `buildCanonicalMesh()`, so this is fully
 * deterministic for a given input buffer regardless of cluster size or
 * shape.
 */
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { UnionFind } from "../mesh/connected-components";
import { yieldIfCancelled } from "../cancellation";
import { repairError } from "./errors";

export interface WeldOptions {
  isCancelled?: () => boolean;
}

export interface WeldLimits {
  maxWeldCandidates: number;
  maxWeldGridCells: number;
}

export interface WeldResult {
  positions: Float32Array;
  verticesBefore: number;
  verticesAfter: number;
  verticesWelded: number;
  trianglesBefore: number;
  trianglesCollapsed: number;
}

export async function weldVertices(positions: Float32Array, toleranceAbs: number, limits: WeldLimits, options: WeldOptions = {}): Promise<WeldResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: limits.maxWeldCandidates }, { isCancelled: options.isCancelled });
  const vertexCount = mesh.uniqueVertexCount;

  if (toleranceAbs <= 0 || vertexCount === 0) {
    return {
      positions: rebuildFromTriangles(mesh.triangles, mesh.vertices),
      verticesBefore: vertexCount,
      verticesAfter: vertexCount,
      verticesWelded: 0,
      trianglesBefore: mesh.triangleCount,
      trianglesCollapsed: 0,
    };
  }

  const uf = new UnionFind(vertexCount);
  const cellSize = toleranceAbs;
  const cellToVertices = new Map<string, number[]>();

  const cellOf = (id: number): [number, number, number] => [
    Math.floor(mesh.vertices[id * 3] / cellSize),
    Math.floor(mesh.vertices[id * 3 + 1] / cellSize),
    Math.floor(mesh.vertices[id * 3 + 2] / cellSize),
  ];

  for (let id = 0; id < vertexCount; id++) {
    await yieldIfCancelled(id, 50_000, options.isCancelled);
    const [cx, cy, cz] = cellOf(id);
    const key = `${cx}_${cy}_${cz}`;
    let list = cellToVertices.get(key);
    if (!list) {
      if (cellToVertices.size >= limits.maxWeldGridCells) throw repairError("STLREPAIR_WELD_LIMIT_EXCEEDED");
      list = [];
      cellToVertices.set(key, list);
    }
    list.push(id);
  }

  const toleranceSq = toleranceAbs * toleranceAbs;
  for (let id = 0; id < vertexCount; id++) {
    await yieldIfCancelled(id, 20_000, options.isCancelled);
    const [cx, cy, cz] = cellOf(id);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const neighbors = cellToVertices.get(`${cx + dx}_${cy + dy}_${cz + dz}`);
          if (!neighbors) continue;
          for (const other of neighbors) {
            if (other <= id) continue; // each unordered pair considered once
            if (distanceSquared(mesh.vertices, id, other) <= toleranceSq) uf.union(id, other);
          }
        }
      }
    }
  }

  // Deterministic representative: the lowest vertex ID in each cluster.
  const representativeOf = new Int32Array(vertexCount).fill(-1);
  const minByRoot = new Map<number, number>();
  for (let id = 0; id < vertexCount; id++) {
    const root = uf.find(id);
    const current = minByRoot.get(root);
    if (current === undefined || id < current) minByRoot.set(root, id);
  }
  for (let id = 0; id < vertexCount; id++) {
    representativeOf[id] = minByRoot.get(uf.find(id))!;
  }

  const uniqueRepresentatives = new Set(minByRoot.values());
  const verticesAfter = uniqueRepresentatives.size;

  let trianglesCollapsed = 0;
  const outPositions: number[] = [];
  for (const tri of mesh.triangles) {
    const [a, b, c] = tri.vertexIds.map((v) => representativeOf[v]);
    if (a === b || b === c || a === c) {
      trianglesCollapsed++;
      continue;
    }
    for (const v of [a, b, c]) {
      const base = v * 3;
      const x = mesh.vertices[base];
      const y = mesh.vertices[base + 1];
      const z = mesh.vertices[base + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw repairError("STLREPAIR_VERIFICATION_FAILED");
      }
      outPositions.push(x, y, z);
    }
  }

  return {
    positions: Float32Array.from(outPositions),
    verticesBefore: vertexCount,
    verticesAfter,
    verticesWelded: vertexCount - verticesAfter,
    trianglesBefore: mesh.triangleCount,
    trianglesCollapsed,
  };
}

function distanceSquared(vertices: Float32Array, a: number, b: number): number {
  const dx = vertices[a * 3] - vertices[b * 3];
  const dy = vertices[a * 3 + 1] - vertices[b * 3 + 1];
  const dz = vertices[a * 3 + 2] - vertices[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function rebuildFromTriangles(triangles: readonly { vertexIds: readonly [number, number, number] }[], vertices: Float32Array): Float32Array {
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
