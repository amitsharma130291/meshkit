/**
 * Sampled geometric deviation — deliberately NOT called "Hausdorff
 * distance": this measures a bounded SAMPLE of points (each mesh's own
 * vertices and triangle centroids) against the other mesh's nearest
 * surface point, not every point on both surfaces. Accelerated with the
 * same uniform-grid bucketing strategy `mesh/spatial-index.ts` already
 * uses for self-intersection candidate search, purpose-built here for a
 * different query shape (nearest triangle to an arbitrary point, not
 * triangle-pair candidates) rather than forcing that function's own
 * pair-search signature to fit.
 */
export interface SurfaceSample {
  positions: Float32Array;
  triangleVertexIds: Int32Array;
  triangleCount: number;
}

export interface DeviationLimits {
  maxSamples: number;
  maxGridCells: number;
}

/** Barycentric closest-point-on-triangle (Ericson, Real-Time Collision Detection §5.1.5). */
export function closestPointOnTriangle(
  point: readonly [number, number, number],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): [number, number, number] {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: [number, number, number] = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const dot = (u: readonly [number, number, number], v: readonly [number, number, number]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [...a];

  const bp: [number, number, number] = [point[0] - b[0], point[1] - b[1], point[2] - b[2]];
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [...b];

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }

  const cp: [number, number, number] = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [...c];

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

interface Grid {
  cellSize: number;
  min: [number, number, number];
  cells: Map<string, number[]>;
}

function cellKey(x: number, y: number, z: number): string {
  return `${x}_${y}_${z}`;
}

function buildGrid(surface: SurfaceSample, limits: DeviationLimits): Grid {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < surface.positions.length; i += 3) {
    minX = Math.min(minX, surface.positions[i]);
    minY = Math.min(minY, surface.positions[i + 1]);
    minZ = Math.min(minZ, surface.positions[i + 2]);
    maxX = Math.max(maxX, surface.positions[i]);
    maxY = Math.max(maxY, surface.positions[i + 1]);
    maxZ = Math.max(maxZ, surface.positions[i + 2]);
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const targetCells = Math.max(1, Math.min(limits.maxGridCells, surface.triangleCount || 1));
  const cellSize = diagonal / Math.cbrt(targetCells);

  const cells = new Map<string, number[]>();
  for (let t = 0; t < surface.triangleCount; t++) {
    const base = t * 3;
    const ids = [surface.triangleVertexIds[base], surface.triangleVertexIds[base + 1], surface.triangleVertexIds[base + 2]];
    const cx = ids.reduce((sum, id) => sum + surface.positions[id * 3], 0) / 3;
    const cy = ids.reduce((sum, id) => sum + surface.positions[id * 3 + 1], 0) / 3;
    const cz = ids.reduce((sum, id) => sum + surface.positions[id * 3 + 2], 0) / 3;
    const key = cellKey(Math.floor((cx - minX) / cellSize), Math.floor((cy - minY) / cellSize), Math.floor((cz - minZ) / cellSize));
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(t);
  }
  return { cellSize, min: [minX, minY, minZ], cells };
}

function nearestDistance(point: readonly [number, number, number], surface: SurfaceSample, grid: Grid): number {
  const [cx, cy, cz] = [
    Math.floor((point[0] - grid.min[0]) / grid.cellSize),
    Math.floor((point[1] - grid.min[1]) / grid.cellSize),
    Math.floor((point[2] - grid.min[2]) / grid.cellSize),
  ];
  let best = Infinity;
  for (let ring = 0; ring <= 3; ring++) {
    let found = false;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue; // only the new shell each ring
          const key = cellKey(cx + dx, cy + dy, cz + dz);
          const triangles = grid.cells.get(key);
          if (!triangles) continue;
          found = true;
          for (const t of triangles) {
            const base = t * 3;
            const [ia, ib, ic] = [surface.triangleVertexIds[base], surface.triangleVertexIds[base + 1], surface.triangleVertexIds[base + 2]];
            const a: [number, number, number] = [surface.positions[ia * 3], surface.positions[ia * 3 + 1], surface.positions[ia * 3 + 2]];
            const b: [number, number, number] = [surface.positions[ib * 3], surface.positions[ib * 3 + 1], surface.positions[ib * 3 + 2]];
            const c: [number, number, number] = [surface.positions[ic * 3], surface.positions[ic * 3 + 1], surface.positions[ic * 3 + 2]];
            const closest = closestPointOnTriangle(point, a, b, c);
            const d = Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]);
            if (d < best) best = d;
          }
        }
      }
    }
    // One extra ring past the first hit, to catch a nearer triangle straddling a cell boundary — then stop.
    if (found && ring > 0) break;
  }
  return best;
}

function collectSamplePoints(surface: SurfaceSample, budget: number): [number, number, number][] {
  const points: [number, number, number][] = [];
  const vertexCount = surface.positions.length / 3;
  for (let v = 0; v < vertexCount && points.length < budget; v++) {
    points.push([surface.positions[v * 3], surface.positions[v * 3 + 1], surface.positions[v * 3 + 2]]);
  }
  for (let t = 0; t < surface.triangleCount && points.length < budget; t++) {
    const base = t * 3;
    const [ia, ib, ic] = [surface.triangleVertexIds[base], surface.triangleVertexIds[base + 1], surface.triangleVertexIds[base + 2]];
    points.push([
      (surface.positions[ia * 3] + surface.positions[ib * 3] + surface.positions[ic * 3]) / 3,
      (surface.positions[ia * 3 + 1] + surface.positions[ib * 3 + 1] + surface.positions[ic * 3 + 1]) / 3,
      (surface.positions[ia * 3 + 2] + surface.positions[ib * 3 + 2] + surface.positions[ic * 3 + 2]) / 3,
    ]);
  }
  return points;
}

export interface SampledDeviationResult {
  maxDeviation: number;
  meanDeviation: number;
  rmsDeviation: number;
  sampleCount: number;
  completed: boolean;
  incompleteDueToSafetyCeiling: boolean;
}

/**
 * Bidirectional sampled deviation: `original`'s own vertex+centroid
 * samples are measured against `optimized`'s surface, and vice versa —
 * catches both "the simplified surface strayed from the original" and
 * "the original had detail the simplified surface flattened away."
 */
export function sampleDeviation(original: SurfaceSample, optimized: SurfaceSample, limits: DeviationLimits): SampledDeviationResult {
  const perSideBudget = Math.floor(limits.maxSamples / 2);
  const originalSamples = collectSamplePoints(original, perSideBudget);
  const optimizedSamples = collectSamplePoints(optimized, perSideBudget);

  const totalRequested = originalSamples.length + optimizedSamples.length;
  const incompleteDueToSafetyCeiling = totalRequested >= limits.maxSamples;

  const optimizedGrid = buildGrid(optimized, limits);
  const originalGrid = buildGrid(original, limits);

  const distances: number[] = [];
  for (const p of originalSamples) distances.push(nearestDistance(p, optimized, optimizedGrid));
  for (const p of optimizedSamples) distances.push(nearestDistance(p, original, originalGrid));

  const sampleCount = distances.length;
  const maxDeviation = sampleCount > 0 ? Math.max(...distances) : 0;
  const meanDeviation = sampleCount > 0 ? distances.reduce((s, d) => s + d, 0) / sampleCount : 0;
  const rmsDeviation = sampleCount > 0 ? Math.sqrt(distances.reduce((s, d) => s + d * d, 0) / sampleCount) : 0;

  return {
    maxDeviation,
    meanDeviation,
    rmsDeviation,
    sampleCount,
    completed: !incompleteDueToSafetyCeiling,
    incompleteDueToSafetyCeiling,
  };
}
