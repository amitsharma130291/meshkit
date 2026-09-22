import type { STLBounds } from "../stl/types";

export type PLYFormat = "ascii" | "binary_little_endian" | "binary_big_endian";

/**
 * The 8 standard PLY scalar types, normalized to one internal vocabulary —
 * a header token like `uchar`, `uint8` or `int` (a common but non-standard
 * alias) all resolve to one of these before anything else in this module
 * looks at a type. See `scalar-types.ts`.
 */
export type PLYScalarType = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";

export interface PLYScalarProperty {
  kind: "scalar";
  type: PLYScalarType;
  name: string;
}

export interface PLYListProperty {
  kind: "list";
  /** The type of the per-row length prefix (commonly `uchar`, but the format allows any scalar type here). */
  countType: PLYScalarType;
  itemType: PLYScalarType;
  name: string;
}

export type PLYProperty = PLYScalarProperty | PLYListProperty;

export interface PLYElement {
  name: string;
  count: number;
  /** In declared header order — this order is what a binary body's byte layout (and an ASCII body's token order) follows for every row of this element. */
  properties: PLYProperty[];
}

export interface PLYHeader {
  format: PLYFormat;
  elements: PLYElement[];
}

/**
 * PLY has no notion of a measurement unit — like OBJ, a coordinate is just
 * a number. MeshKit preserves coordinates exactly rather than guessing a
 * unit, so there is deliberately no unit field anywhere in this module's
 * types.
 */
export type ConversionWarningCode =
  | "vertex-colors-not-preserved"
  | "vertex-normals-not-preserved"
  | "texture-coordinates-not-preserved"
  | "unknown-elements-skipped"
  | "unknown-properties-skipped"
  | "double-precision-narrowed"
  | "non-planar-faces";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

/** The flattened, triangulated geometry ready for preview/STL serialization. */
export interface PLYParseResult {
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  sourceVertexCount: number;
  sourceFaceCount: number;
  vertexPropertyCount: number;
  facePropertyCount: number;
  unknownElementCount: number;
  unknownPropertyCount: number;
  format: PLYFormat;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface PLYToSTLResult extends PLYParseResult {
  stlBuffer: ArrayBuffer;
}

export interface PLYLimits {
  maxFileBytes: number;
  /** Safety ceiling on header text alone, in case `end_header` never appears (a malicious or corrupted file). */
  maxHeaderBytes: number;
  maxElements: number;
  maxPropertiesPerElement: number;
  maxVertexCount: number;
  /** Vertices per face, before triangulation — see `DEFAULT_PLY_LIMITS` for why this is much smaller than `maxTriangles`. */
  maxFaceVertexCount: number;
  maxTriangles: number;
  /** Per-list-property row-count ceiling, checked before allocating that row's value array. */
  maxListCount: number;
  /** Hard ceiling on ear-clipping iterations per face — guards against a pathological polygon hanging the worker. */
  maxTriangulationIterations: number;
  /** Validated against the STL serializer's computed output size before allocating it. */
  maxStlBytes: number;
}

/**
 * Conservative defaults for the free converter. A browser-stability safety
 * ceiling, not a Pro-tier gate — see docs/ARCHITECTURE.md. `maxFaceVertexCount`
 * is intentionally much smaller than `maxTriangles`, for the same reason
 * documented on `OBJLimits`: ear clipping is worst-case O(n^3) in a single
 * face's vertex count, so a huge n-gon is a much cheaper way to construct a
 * pathological input than a huge triangle count is.
 */
export const DEFAULT_PLY_LIMITS: PLYLimits = {
  maxFileBytes: 150 * 1024 * 1024,
  maxHeaderBytes: 2 * 1024 * 1024,
  maxElements: 1000,
  maxPropertiesPerElement: 256,
  maxVertexCount: 5_000_000,
  maxFaceVertexCount: 256,
  maxTriangles: 3_000_000,
  maxListCount: 1_000_000,
  maxTriangulationIterations: 10_000,
  maxStlBytes: 400 * 1024 * 1024,
};
