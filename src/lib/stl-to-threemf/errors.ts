import { createSafeError, type ErrorCode, type SafeError } from "../errors";

/**
 * Only the two codes genuinely specific to the STL→3MF pipeline itself
 * (not shared with the 3MF writer used elsewhere). Every other
 * write-side failure goes through `src/lib/threemf/errors.ts`'s existing
 * `ThreeMFParseException` — the same exception type the 3MF *reader*
 * already uses, since its `ThreeMFErrorCode` type (`Extract<ErrorCode,
 * 'THREEMF_${string}'>`) automatically covers every new writer-side
 * `THREEMF_*` code too, with zero changes needed to that file. STL input
 * failures reuse `src/lib/stl/errors.ts` unchanged.
 */
export type STLToThreeMFErrorCode = Extract<ErrorCode, `STL_TO_THREEMF_${string}`>;

export class STLToThreeMFException extends Error {
  readonly code: STLToThreeMFErrorCode;

  constructor(code: STLToThreeMFErrorCode) {
    super(code);
    this.name = "STLToThreeMFException";
    this.code = code;
  }
}

export function stlToThreeMFError(code: STLToThreeMFErrorCode): STLToThreeMFException {
  return new STLToThreeMFException(code);
}

export function toSTLToThreeMFSafeError(error: unknown): SafeError {
  if (error instanceof STLToThreeMFException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
