/**
 * Removes triangles whose (already-resolved) normal is the zero vector —
 * `src/lib/stl/normals.ts`'s signal for "zero area." The STL parser
 * itself doesn't reject these (a degenerate triangle is still valid,
 * parseable STL), so this is a shared defense-in-depth layer for any
 * converter that writes indexed geometry from parsed STL data: skip,
 * count, warn — never call it repair. Introduced during the STL→OBJ
 * writer (Phase 3D) and reused as-is by the STL→3MF writer (Phase 3E),
 * since filtering degenerate triangles out of parsed STL geometry has
 * nothing to do with the output format.
 */
import { computeBounds } from "./bounds";
import type { STLBounds, STLParseResult } from "./types";

export interface FilteredGeometry {
  positions: Float32Array;
  normals: Float32Array;
  skippedDegenerateTriangles: number;
  bounds: STLBounds;
}

export function filterDegenerateTriangles(parsed: STLParseResult): FilteredGeometry {
  const triangleCount = parsed.positions.length / 9;
  const keptPositions: number[] = [];
  const keptNormals: number[] = [];
  let skippedDegenerateTriangles = 0;

  for (let t = 0; t < triangleCount; t++) {
    const base = t * 9;
    if (parsed.normals[base] === 0 && parsed.normals[base + 1] === 0 && parsed.normals[base + 2] === 0) {
      skippedDegenerateTriangles++;
      continue;
    }
    for (let i = 0; i < 9; i++) keptPositions.push(parsed.positions[base + i]);
    for (let i = 0; i < 9; i++) keptNormals.push(parsed.normals[base + i]);
  }

  const positions = Float32Array.from(keptPositions);
  return {
    positions,
    normals: Float32Array.from(keptNormals),
    skippedDegenerateTriangles,
    bounds: computeBounds(positions),
  };
}
