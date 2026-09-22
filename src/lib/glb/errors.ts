import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type GLBErrorCode = Extract<ErrorCode, `GLB_${string}`>;

/** Thrown by the container/schema/accessor/scene modules. Carries only a stable code — never raw JSON, buffer bytes or a stack trace to the UI. */
export class GLBParseException extends Error {
  readonly code: GLBErrorCode;

  constructor(code: GLBErrorCode) {
    super(code);
    this.name = "GLBParseException";
    this.code = code;
  }
}

export function glbError(code: GLBErrorCode): GLBParseException {
  return new GLBParseException(code);
}

/** Maps any error the GLB pipeline might throw to a safe, user-facing error. */
export function toGLBSafeError(error: unknown): SafeError {
  if (error instanceof GLBParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
