/**
 * Shared triangle-normal math, used by both the STL parser (when a
 * declared facet normal is missing/unusable) and the 3MF scene resolver
 * (which has no declared normals at all — 3MF only stores vertex
 * positions and triangle indices).
 */

const MIN_NORMAL_LENGTH_SQ = 1e-12;

/** Unit-length face normal from three vertex positions, via cross product. Returns a zero vector for a degenerate (zero-area) triangle rather than fabricating a direction. */
export function computeFaceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);

  if (length > 1e-12) {
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 0;
    ny = 0;
    nz = 0;
  }

  return [nx, ny, nz];
}

/**
 * Ensures every triangle in a flat position buffer has a finite,
 * unit-length normal. Where `rawNormals` has a usable (finite, non-zero)
 * value for a triangle, it's normalized and kept; otherwise a face normal
 * is computed from that triangle's own transformed vertices.
 */
export function resolveNormals(positions: Float32Array, rawNormals: Float32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  const triangleCount = positions.length / 9;

  for (let t = 0; t < triangleCount; t++) {
    const base = t * 9;
    const nx = rawNormals[base];
    const ny = rawNormals[base + 1];
    const nz = rawNormals[base + 2];
    const lengthSq = nx * nx + ny * ny + nz * nz;

    let fx: number;
    let fy: number;
    let fz: number;

    if (Number.isFinite(lengthSq) && lengthSq > MIN_NORMAL_LENGTH_SQ) {
      const invLength = 1 / Math.sqrt(lengthSq);
      fx = nx * invLength;
      fy = ny * invLength;
      fz = nz * invLength;
    } else {
      [fx, fy, fz] = computeFaceNormal(
        positions[base],
        positions[base + 1],
        positions[base + 2],
        positions[base + 3],
        positions[base + 4],
        positions[base + 5],
        positions[base + 6],
        positions[base + 7],
        positions[base + 8],
      );
    }

    for (let v = 0; v < 3; v++) {
      const i = base + v * 3;
      normals[i] = fx;
      normals[i + 1] = fy;
      normals[i + 2] = fz;
    }
  }

  return normals;
}
