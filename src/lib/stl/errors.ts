import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type STLErrorCode = Extract<ErrorCode, `STL_${string}`>;

/** Thrown by the parser modules. Carries only a stable code — never raw file content or a stack trace to the UI. */
export class STLParseException extends Error {
  readonly code: STLErrorCode;

  constructor(code: STLErrorCode) {
    super(code);
    this.name = "STLParseException";
    this.code = code;
  }
}

export function stlError(code: STLErrorCode): STLParseException {
  return new STLParseException(code);
}

/** Maps any error the parser (or its callers) might throw to a safe, user-facing error. */
export function toSTLSafeError(error: unknown): SafeError {
  if (error instanceof STLParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
