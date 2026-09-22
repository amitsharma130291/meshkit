/**
 * Thin compatibility wrapper: the actual implementation now lives in
 * `src/lib/mesh/number-format.ts` (moved there once the 3MF writer,
 * Phase 3E, needed the identical float32-round-trip guarantee for the
 * same kind of geometry). This wrapper exists only to preserve this
 * module's existing behavior for every caller that already imports from
 * `"./number-format"` (OBJ's own `serialize.ts`, and existing tests) —
 * translating the shared module's generic, format-agnostic
 * `NonFiniteCoordinateError` into this domain's own `OBJ_NON_FINITE_OUTPUT`,
 * exactly as before this move.
 */
import { formatFloat32 as formatFloat32Mesh } from "../mesh/number-format";
import { NonFiniteCoordinateError } from "../mesh/errors";
import { objError } from "./errors";

export function formatFloat32(value: number): string {
  try {
    return formatFloat32Mesh(value);
  } catch (error) {
    if (error instanceof NonFiniteCoordinateError) throw objError("OBJ_NON_FINITE_OUTPUT");
    throw error;
  }
}
