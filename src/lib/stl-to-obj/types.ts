import type { STLBounds, STLEncoding, STLParseLimits } from "../stl/types";
import type { DeduplicateLimits } from "../obj/deduplicate";
import type { OBJSerializeLimits } from "../obj/serialize";

export type ConversionWarningCode = "degenerate-triangles-skipped";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

export interface STLToOBJResult {
  /** Non-indexed preview geometry (9 floats/triangle, matching every other tool's viewport convention), already excluding skipped degenerate triangles. */
  positions: Float32Array;
  normals: Float32Array;
  objBuffer: ArrayBuffer;
  inputEncoding: STLEncoding;
  inputTriangleCount: number;
  outputFaceCount: number;
  sourceTriangleVertexCount: number;
  uniqueVertexCount: number;
  duplicateVertexReferencesRemoved: number;
  skippedDegenerateTriangles: number;
  outputByteLength: number;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface STLToOBJLimits {
  stl: STLParseLimits;
  dedup: DeduplicateLimits;
  serialize: OBJSerializeLimits;
}

export const DEFAULT_STL_TO_OBJ_LIMITS: STLToOBJLimits = {
  stl: { maxTriangles: 3_000_000 },
  dedup: { maxUniqueVertices: 10_000_000 },
  serialize: { maxFaces: 3_000_000, maxOutputBytes: 400 * 1024 * 1024 },
};
