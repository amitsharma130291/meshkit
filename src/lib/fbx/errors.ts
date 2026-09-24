import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type FBXErrorCode = Extract<ErrorCode, `FBX_${string}`>;

/** Thrown by every FBX module. Carries only a stable code — never raw binary data, a stack trace, a source path or a node's own contents to the UI. */
export class FBXParseException extends Error {
  readonly code: FBXErrorCode;

  constructor(code: FBXErrorCode) {
    super(code);
    this.name = "FBXParseException";
    this.code = code;
  }
}

export function fbxError(code: FBXErrorCode): FBXParseException {
  return new FBXParseException(code);
}

/** Maps any error the FBX pipeline might throw to a safe, user-facing error. */
export function toFBXSafeError(error: unknown): SafeError {
  if (error instanceof FBXParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
