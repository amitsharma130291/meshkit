export type STLEncoding = "binary" | "ascii";

export interface STLBounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export interface STLParseResult {
  encoding: STLEncoding;
  triangleCount: number;
  /** Flat [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...] per-vertex positions, 9 floats per triangle. */
  positions: Float32Array;
  /** Per-vertex normals, same layout as `positions`. Always finite and (where possible) unit length. */
  normals: Float32Array;
  bounds: STLBounds;
  /** Trimmed 80-byte binary header text, or the ASCII "solid" name, when non-empty. */
  header?: string;
}

export interface STLParseLimits {
  /** Hard ceiling on triangle count, independent of file size — protects against pathological allocations. */
  maxTriangles: number;
}

/**
 * Conservative defaults for the free viewer. This is a browser-stability
 * safety ceiling, not a Pro-tier gate — see docs/ARCHITECTURE.md.
 */
export const DEFAULT_STL_LIMITS: STLParseLimits = {
  maxTriangles: 3_000_000,
};
