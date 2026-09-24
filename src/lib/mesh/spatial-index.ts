/**
 * A uniform spatial grid over axis-aligned triangle bounding boxes — the
 * broad-phase acceleration structure `triangle-intersections.ts` uses so
 * self-intersection testing never falls back to an all-pairs O(n^2) scan.
 * Cell size is derived from the mesh's own bounding-box diagonal divided
 * by a target cell count (scale-aware; never a bare global constant), so
 * both a tabletop-sized and a room-sized model get a sensibly sized grid.
 * Each triangle is inserted into every cell its own AABB overlaps (a
 * triangle spanning several cells is found from any of them), and
 * candidate pairs are deduplicated by only ever considering triangle
 * index pairs once, regardless of how many cells they co-occur in.
 */
export interface TriangleBox {
  triangleIndex: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface SpatialIndexLimits {
  /** Target triangles per grid cell — informs cell size, not a hard ceiling. */
  targetTrianglesPerCell: number;
  maxGridCells: number;
  maxCandidatePairs: number;
}

export class CandidatePairLimitExceededError extends Error {
  constructor() {
    super("candidate intersection pair limit exceeded");
    this.name = "CandidatePairLimitExceededError";
  }
}

export class GridCellLimitExceededError extends Error {
  constructor() {
    super("spatial index grid cell limit exceeded");
    this.name = "GridCellLimitExceededError";
  }
}

/** Every triangle-index pair (`a < b`) whose bounding boxes could plausibly intersect — a superset of the true intersecting pairs, never a subset. */
export function findCandidatePairs(boxes: readonly TriangleBox[], limits: SpatialIndexLimits): [number, number][] {
  if (boxes.length === 0) return [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const box of boxes) {
    if (box.min[0] < minX) minX = box.min[0];
    if (box.min[1] < minY) minY = box.min[1];
    if (box.min[2] < minZ) minZ = box.min[2];
    if (box.max[0] > maxX) maxX = box.max[0];
    if (box.max[1] > maxY) maxY = box.max[1];
    if (box.max[2] > maxZ) maxZ = box.max[2];
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const targetCellCount = Math.max(1, Math.ceil(boxes.length / limits.targetTrianglesPerCell));
  const cellSize = diagonal > 0 ? diagonal / Math.cbrt(targetCellCount) : 1;
  const safeCellSize = cellSize > 0 ? cellSize : 1;

  const cellToTriangles = new Map<string, number[]>();

  for (const box of boxes) {
    const minCell = cellCoord(box.min, [minX, minY, minZ], safeCellSize);
    const maxCell = cellCoord(box.max, [minX, minY, minZ], safeCellSize);
    for (let cx = minCell[0]; cx <= maxCell[0]; cx++) {
      for (let cy = minCell[1]; cy <= maxCell[1]; cy++) {
        for (let cz = minCell[2]; cz <= maxCell[2]; cz++) {
          const key = `${cx}_${cy}_${cz}`;
          let list = cellToTriangles.get(key);
          if (!list) {
            if (cellToTriangles.size >= limits.maxGridCells) throw new GridCellLimitExceededError();
            list = [];
            cellToTriangles.set(key, list);
          }
          list.push(box.triangleIndex);
        }
      }
    }
  }

  const seenPairs = new Set<string>();
  const pairs: [number, number][] = [];
  for (const triangleIndices of cellToTriangles.values()) {
    for (let i = 0; i < triangleIndices.length; i++) {
      for (let j = i + 1; j < triangleIndices.length; j++) {
        const a = Math.min(triangleIndices[i], triangleIndices[j]);
        const b = Math.max(triangleIndices[i], triangleIndices[j]);
        const key = `${a}_${b}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        if (pairs.length >= limits.maxCandidatePairs) throw new CandidatePairLimitExceededError();
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function cellCoord(point: readonly [number, number, number], origin: readonly [number, number, number], cellSize: number): [number, number, number] {
  return [Math.floor((point[0] - origin[0]) / cellSize), Math.floor((point[1] - origin[1]) / cellSize), Math.floor((point[2] - origin[2]) / cellSize)];
}
