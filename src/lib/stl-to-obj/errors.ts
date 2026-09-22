import { createSafeError, type ErrorCode, type SafeError } from "../errors";

/**
 * Only the two codes that are genuinely specific to the STL→OBJ pipeline
 * itself (not shared with the OBJ writer used elsewhere). Every other
 * write-side failure goes through `src/lib/obj/errors.ts`'s
 * `OBJParseException` — the same file already used by both the OBJ
 * *reader* and, as of this phase, the OBJ *writer* (mirroring
 * `src/lib/stl/errors.ts`, which is likewise shared by the STL reader and
 * writer). STL input failures reuse `src/lib/stl/errors.ts` unchanged.
 */
export type STLToOBJErrorCode = Extract<ErrorCode, `STL_TO_OBJ_${string}`>;

export class STLToOBJException extends Error {
  readonly code: STLToOBJErrorCode;

  constructor(code: STLToOBJErrorCode) {
    super(code);
    this.name = "STLToOBJException";
    this.code = code;
  }
}

export function stlToOBJError(code: STLToOBJErrorCode): STLToOBJException {
  return new STLToOBJException(code);
}

export function toSTLToOBJSafeError(error: unknown): SafeError {
  if (error instanceof STLToOBJException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
