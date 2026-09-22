/**
 * STL → OBJ orchestration. Every building block here is exported
 * individually (not just one monolithic `convert()`) so the worker can
 * call them in sequence with an honest progress message posted between
 * each — the same shape `src/workers/threemf-to-stl.worker.ts` uses
 * around `src/lib/threemf/convert.ts`'s pieces.
 */
import { parseSTL } from "../stl/parse";
import { filterDegenerateTriangles, type FilteredGeometry } from "../stl/degenerate";
import { objError, OBJParseException } from "../obj/errors";
import { deduplicateVertices, type DeduplicatedGeometry } from "../obj/deduplicate";
import { serializeOBJ, type OBJSerializeResult, type OBJSerializeStage } from "../obj/serialize";
import { CancellationRequested } from "../cancellation";
import { stlToOBJError } from "./errors";
import type { ConversionWarning, STLToOBJLimits, STLToOBJResult } from "./types";

// Re-exported for backward compatibility — this module used to define
// both of these itself; the implementation now lives in
// `src/lib/stl/degenerate.ts` (format-neutral, shared with the STL→3MF
// writer). Nothing outside this file needs to change its import path.
export { filterDegenerateTriangles, type FilteredGeometry };

/** One geometric normal per (already-degenerate-filtered) triangle, taken from the broadcast per-vertex normal `resolveNormals()` already produced. */
export function extractFaceNormals(triangleNormals: Float32Array): Float32Array {
  const triangleCount = triangleNormals.length / 9;
  const faceNormals = new Float32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    faceNormals[t * 3] = triangleNormals[t * 9];
    faceNormals[t * 3 + 1] = triangleNormals[t * 9 + 1];
    faceNormals[t * 3 + 2] = triangleNormals[t * 9 + 2];
  }
  return faceNormals;
}

export interface DeduplicateStepOptions {
  isCancelled?: () => boolean;
}

/** Wraps `deduplicateVertices()`, translating any unexpected (non-cancellation, non-well-typed) failure into the specific `STL_TO_OBJ_DEDUPLICATION_FAILED` diagnostic category. */
export async function deduplicateStep(
  positions: Float32Array,
  limits: STLToOBJLimits["dedup"],
  options: DeduplicateStepOptions = {},
): Promise<DeduplicatedGeometry> {
  try {
    return await deduplicateVertices(positions, limits, { isCancelled: options.isCancelled });
  } catch (error) {
    if (error instanceof CancellationRequested) throw error;
    if (error instanceof OBJParseException) throw error;
    throw stlToOBJError("STL_TO_OBJ_DEDUPLICATION_FAILED");
  }
}

export interface SerializeStepOptions {
  isCancelled?: () => boolean;
  onStage?: (stage: OBJSerializeStage) => void;
}

export function serializeStep(
  geometry: DeduplicatedGeometry,
  faceNormals: Float32Array,
  limits: STLToOBJLimits["serialize"],
  options: SerializeStepOptions = {},
): Promise<OBJSerializeResult> {
  return serializeOBJ(geometry, faceNormals, limits, options);
}

function buildWarnings(skippedDegenerateTriangles: number): ConversionWarning[] {
  if (skippedDegenerateTriangles === 0) return [];
  return [
    {
      code: "degenerate-triangles-skipped",
      message: "Zero-area STL facets cannot produce a useful OBJ surface and were omitted from the download.",
    },
  ];
}

/**
 * The full pipeline in one call — used by tests and anywhere outside the
 * worker's staged progress reporting. The worker itself calls
 * `parseSTL()`/`filterDegenerateTriangles()`/`deduplicateStep()`/`serializeStep()`
 * directly so it can post a progress message between each.
 */
export async function convertSTLToOBJ(buffer: ArrayBuffer, limits: STLToOBJLimits, isCancelled?: () => boolean): Promise<STLToOBJResult> {
  const parsed = parseSTL(buffer, limits.stl);
  const filtered = filterDegenerateTriangles(parsed);

  if (filtered.positions.length === 0) {
    // Every triangle was degenerate — fail fast with the same
    // "nothing to export" code `serializeOBJ()` would eventually reach on
    // its own, rather than doing wasted dedup/serialize work first.
    throw objError("OBJ_NO_OUTPUT_GEOMETRY");
  }

  const geometry = await deduplicateStep(filtered.positions, limits.dedup, { isCancelled });
  const faceNormals = extractFaceNormals(filtered.normals);
  const serialized = await serializeStep(geometry, faceNormals, limits.serialize, { isCancelled });

  return {
    positions: filtered.positions,
    normals: filtered.normals,
    objBuffer: sliceExact(serialized.bytes),
    inputEncoding: parsed.encoding,
    inputTriangleCount: parsed.triangleCount,
    outputFaceCount: serialized.faceCount,
    sourceTriangleVertexCount: geometry.sourceVertexCount,
    uniqueVertexCount: geometry.uniqueVertexCount,
    duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
    skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
    outputByteLength: serialized.outputByteLength,
    bounds: filtered.bounds,
    warnings: buildWarnings(filtered.skippedDegenerateTriangles),
  };
}

/** `Uint8Array.buffer` can be larger than the view when the array came from a pooled/sliced allocation; TextEncoder().encode() doesn't do this in practice, but slicing defensively keeps the transferred ArrayBuffer exactly sized. */
function sliceExact(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}
