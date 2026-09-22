import type { STLBounds, STLEncoding, STLParseLimits } from "../stl/types";
import type { DeduplicateLimits } from "../mesh/deduplicate";
import type { ModelWriteLimits } from "../threemf/model-writer";
import type { PackageWriteLimits } from "../threemf/package-writer";

export type ConversionWarningCode = "degenerate-triangles-skipped";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

export interface STLToThreeMFResult {
  /** Non-indexed preview geometry (9 floats/triangle, matching every other tool's viewport convention), already excluding skipped degenerate triangles. */
  positions: Float32Array;
  normals: Float32Array;
  threeMFBuffer: ArrayBuffer;
  inputEncoding: STLEncoding;
  inputTriangleCount: number;
  outputTriangleCount: number;
  sourceTriangleVertexCount: number;
  uniqueVertexCount: number;
  duplicateVertexReferencesRemoved: number;
  skippedDegenerateTriangles: number;
  /** A declared output assumption, never a detected input fact — see docs/ARCHITECTURE.md's "Millimetre declaration policy." */
  declaredUnit: "millimeter";
  coordinateScale: 1;
  outputByteLength: number;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface STLToThreeMFLimits {
  stl: STLParseLimits;
  dedup: DeduplicateLimits;
  model: ModelWriteLimits;
  package: PackageWriteLimits;
}

export const DEFAULT_STL_TO_THREEMF_LIMITS: STLToThreeMFLimits = {
  stl: { maxTriangles: 3_000_000 },
  dedup: { maxUniqueVertices: 10_000_000 },
  model: { maxTriangles: 3_000_000 },
  package: { maxOutputBytes: 400 * 1024 * 1024 },
};
