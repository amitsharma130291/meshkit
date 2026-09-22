/**
 * STL → 3MF orchestration. Every building block here is exported
 * individually (not just one monolithic `convert()`) so the worker can
 * call them in sequence with an honest progress message posted between
 * each — the same shape `src/lib/stl-to-obj/convert.ts` and
 * `src/workers/threemf-to-stl.worker.ts` both use around their own
 * pipelines.
 */
import { parseSTL } from "../stl/parse";
import { filterDegenerateTriangles } from "../stl/degenerate";
import { deduplicateVertices, type DeduplicatedGeometry } from "../mesh/deduplicate";
import { NonFiniteCoordinateError, UniqueVertexLimitExceededError } from "../mesh/errors";
import { writeModelXML } from "../threemf/model-writer";
import { writeThreeMFPackage } from "../threemf/package-writer";
import { threeMFError } from "../threemf/errors";
import { CancellationRequested } from "../cancellation";
import { stlToThreeMFError } from "./errors";
import type { ConversionWarning, STLToThreeMFLimits, STLToThreeMFResult } from "./types";

export interface DeduplicateStepOptions {
  isCancelled?: () => boolean;
}

/** Wraps the shared `deduplicateVertices()`, translating its generic, format-agnostic exceptions into this pipeline's own `THREEMF_*`/`STL_TO_THREEMF_*` codes. */
export async function deduplicateStep(
  positions: Float32Array,
  limits: STLToThreeMFLimits["dedup"],
  options: DeduplicateStepOptions = {},
): Promise<DeduplicatedGeometry> {
  try {
    return await deduplicateVertices(positions, limits, { isCancelled: options.isCancelled });
  } catch (error) {
    if (error instanceof CancellationRequested) throw error;
    if (error instanceof NonFiniteCoordinateError) throw threeMFError("THREEMF_NON_FINITE_OUTPUT");
    if (error instanceof UniqueVertexLimitExceededError) throw threeMFError("THREEMF_VERTEX_LIMIT_EXCEEDED");
    throw stlToThreeMFError("STL_TO_THREEMF_DEDUPLICATION_FAILED");
  }
}

/**
 * Cheap, non-parsing sanity checks performed before reporting success —
 * full round-trip verification through the production 3MF reader is
 * comprehensively covered in tests and browser verification instead,
 * since re-parsing here would materially double conversion cost for a
 * large model.
 */
export function verifyPackageOutput(buffer: ArrayBuffer, modelXmlLength: number, limits: STLToThreeMFLimits["package"]): void {
  if (buffer.byteLength === 0) throw threeMFError("THREEMF_SERIALIZATION_FAILED");
  if (modelXmlLength === 0) throw threeMFError("THREEMF_XML_SERIALIZATION_FAILED");
  if (buffer.byteLength > limits.maxOutputBytes) throw threeMFError("THREEMF_OUTPUT_TOO_LARGE");
}

function buildWarnings(skippedDegenerateTriangles: number): ConversionWarning[] {
  if (skippedDegenerateTriangles === 0) return [];
  return [
    {
      code: "degenerate-triangles-skipped",
      message: "Zero-area STL facets cannot produce a useful 3MF surface and were omitted.",
    },
  ];
}

/**
 * The full pipeline in one call — used by tests and anywhere outside the
 * worker's staged progress reporting. The worker itself calls
 * `parseSTL()`/`filterDegenerateTriangles()`/`deduplicateStep()`/`writeModelXML()`/
 * `writeThreeMFPackage()`/`verifyPackageOutput()` directly so it can post
 * a progress message between each.
 */
export async function convertSTLToThreeMF(buffer: ArrayBuffer, limits: STLToThreeMFLimits, isCancelled?: () => boolean): Promise<STLToThreeMFResult> {
  const parsed = parseSTL(buffer, limits.stl);
  const filtered = filterDegenerateTriangles(parsed);

  if (filtered.positions.length === 0) {
    // Every triangle was degenerate — fail fast with the same
    // "nothing to export" code `writeModelXML()` would eventually reach
    // on its own, rather than doing wasted dedup/serialize work first.
    throw threeMFError("THREEMF_NO_OUTPUT_GEOMETRY");
  }

  const geometry = await deduplicateStep(filtered.positions, limits.dedup, { isCancelled });
  const modelXML = await writeModelXML(geometry, limits.model, { isCancelled });
  const threeMFBuffer = writeThreeMFPackage(modelXML, limits.package);
  verifyPackageOutput(threeMFBuffer, modelXML.length, limits.package);

  const outputTriangleCount = geometry.triangleVertexIndices.length / 3;

  return {
    positions: filtered.positions,
    normals: filtered.normals,
    threeMFBuffer,
    inputEncoding: parsed.encoding,
    inputTriangleCount: parsed.triangleCount,
    outputTriangleCount,
    sourceTriangleVertexCount: geometry.sourceVertexCount,
    uniqueVertexCount: geometry.uniqueVertexCount,
    duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
    skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
    declaredUnit: "millimeter",
    coordinateScale: 1,
    outputByteLength: threeMFBuffer.byteLength,
    bounds: filtered.bounds,
    warnings: buildWarnings(filtered.skippedDegenerateTriangles),
  };
}
