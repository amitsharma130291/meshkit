import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type PLYErrorCode = Extract<ErrorCode, `PLY_${string}`>;

/** Thrown by the header/reader/properties/parser modules. Carries only a stable code — never raw file content or a stack trace to the UI. */
export class PLYParseException extends Error {
  readonly code: PLYErrorCode;

  constructor(code: PLYErrorCode) {
    super(code);
    this.name = "PLYParseException";
    this.code = code;
  }
}

export function plyError(code: PLYErrorCode): PLYParseException {
  return new PLYParseException(code);
}

/** Maps any error the PLY pipeline might throw to a safe, user-facing error. */
export function toPLYSafeError(error: unknown): SafeError {
  if (error instanceof PLYParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
