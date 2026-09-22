import type { STLBounds } from "../stl/types";

/**
 * OBJ has no notion of a measurement unit — a coordinate is just a number.
 * MeshKit preserves coordinates exactly rather than guessing a unit, so
 * there is deliberately no unit field anywhere in this module's types.
 */
export type ConversionWarningCode =
  | "materials-not-preserved"
  | "textures-not-preserved"
  | "smooth-shading-converted"
  | "groups-merged"
  | "vertex-colors-not-preserved"
  | "lines-ignored"
  | "points-ignored"
  | "non-planar-faces";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

/** The flattened, triangulated, unit-preserved geometry ready for preview/STL serialization. */
export interface OBJParseResult {
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  sourceVertexCount: number;
  sourceFaceCount: number;
  objectCount: number;
  groupCount: number;
  materialLibraryCount: number;
  usedMaterialCount: number;
  ignoredLineCount: number;
  ignoredPointCount: number;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface OBJToSTLResult extends OBJParseResult {
  stlBuffer: ArrayBuffer;
}

export interface OBJLimits {
  /** Ceiling applied to the raw buffer before any text decoding happens. */
  maxTextBytes: number;
  maxVertexCount: number;
  /** Vertices per polygon face, before triangulation. */
  maxFaceVertexCount: number;
  maxTriangles: number;
  /** Rejects absurd coordinate values (e.g. malformed scientific notation) before they reach geometry math. */
  maxCoordinateMagnitude: number;
  /** Hard ceiling on ear-clipping iterations per face — guards against a pathological polygon hanging the worker. */
  maxTriangulationIterations: number;
}

/**
 * Conservative defaults for the free converter. A browser-stability safety
 * ceiling, not a Pro-tier gate — see docs/ARCHITECTURE.md. `maxFaceVertexCount`
 * is intentionally much smaller than `maxTriangles`: ear clipping is
 * worst-case O(n^3) in the vertex count of a single face, so a huge n-gon
 * is a much cheaper way to construct a pathological input than a huge
 * triangle count is.
 */
export const DEFAULT_OBJ_LIMITS: OBJLimits = {
  maxTextBytes: 150 * 1024 * 1024,
  maxVertexCount: 5_000_000,
  maxFaceVertexCount: 256,
  maxTriangles: 3_000_000,
  maxCoordinateMagnitude: 1e7,
  maxTriangulationIterations: 10_000,
};
