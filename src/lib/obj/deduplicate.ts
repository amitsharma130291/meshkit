/**
 * Thin compatibility wrapper: the actual implementation now lives in
 * `src/lib/mesh/deduplicate.ts` (moved there once the 3MF writer,
 * Phase 3E, needed the identical exact-vertex-indexing behavior for the
 * same kind of geometry — see that module's own header comment for the
 * full rationale). This wrapper exists only to preserve this module's
 * existing behavior for every caller that already imports from
 * `"./deduplicate"` (`src/lib/stl-to-obj/convert.ts`, and existing
 * tests) — translating the shared module's generic, format-agnostic
 * exceptions into this domain's own `OBJ_NON_FINITE_OUTPUT` /
 * `OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED`, exactly as before this move.
 */
import {
  deduplicateVertices as deduplicateVerticesMesh,
  type DeduplicatedGeometry,
  type DeduplicateLimits,
  type DeduplicateOptions,
} from "../mesh/deduplicate";
import { NonFiniteCoordinateError, UniqueVertexLimitExceededError } from "../mesh/errors";
import { objError } from "./errors";

export type { DeduplicatedGeometry, DeduplicateLimits, DeduplicateOptions };

export async function deduplicateVertices(
  positions: Float32Array,
  limits: DeduplicateLimits,
  options: DeduplicateOptions = {},
): Promise<DeduplicatedGeometry> {
  try {
    return await deduplicateVerticesMesh(positions, limits, options);
  } catch (error) {
    if (error instanceof NonFiniteCoordinateError) throw objError("OBJ_NON_FINITE_OUTPUT");
    if (error instanceof UniqueVertexLimitExceededError) throw objError("OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED");
    throw error; // CancellationRequested and anything else pass through unchanged
  }
}
