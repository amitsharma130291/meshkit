import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type ThreeMFErrorCode = Extract<ErrorCode, `THREEMF_${string}`>;

/** Thrown by the package/relationship/XML/scene modules. Carries only a stable code — never raw ZIP/XML content to the UI. */
export class ThreeMFParseException extends Error {
  readonly code: ThreeMFErrorCode;

  constructor(code: ThreeMFErrorCode) {
    super(code);
    this.name = "ThreeMFParseException";
    this.code = code;
  }
}

export function threeMFError(code: ThreeMFErrorCode): ThreeMFParseException {
  return new ThreeMFParseException(code);
}

/** Maps any error the converter pipeline might throw to a safe, user-facing error. */
export function toThreeMFSafeError(error: unknown): SafeError {
  if (error instanceof ThreeMFParseException) {
    return createSafeError(error.code);
  }
  return createSafeError("UNKNOWN_ERROR");
}
