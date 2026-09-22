import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type OBJErrorCode = Extract<ErrorCode, `OBJ_${string}`>;

/** Thrown by the tokenizer/parser/triangulator modules. Carries only a stable code — never raw file content, a source line or a stack trace to the UI. */
export class OBJParseException extends Error {
  readonly code: OBJErrorCode;

  constructor(code: OBJErrorCode) {
    super(code);
    this.name = "OBJParseException";
    this.code = code;
  }
}

export function objError(code: OBJErrorCode): OBJParseException {
  return new OBJParseException(code);
}

/** Maps any error the OBJ pipeline might throw to a safe, user-facing error. */
export function toOBJSafeError(error: unknown): SafeError {
  if (error instanceof OBJParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
