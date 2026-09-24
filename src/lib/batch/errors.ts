/**
 * Error translation for the shared batch pipeline — same shape every
 * other format's `errors.ts` uses (`stl-repair/errors.ts`,
 * `gcode/errors.ts`, etc.): one exception class carrying a `BATCH_${string}`
 * code, a factory, and a `toBatchSafeError` translator that never leaks
 * raw exception text to the UI.
 */
import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type BatchErrorCode = Extract<ErrorCode, `BATCH_${string}`>;

export class BatchException extends Error {
  readonly code: BatchErrorCode;

  constructor(code: BatchErrorCode) {
    super(code);
    this.name = "BatchException";
    this.code = code;
  }
}

export function batchError(code: BatchErrorCode): BatchException {
  return new BatchException(code);
}

export function toBatchSafeError(error: unknown): SafeError {
  if (error instanceof BatchException) return createSafeError(error.code);
  return createSafeError("UNKNOWN_ERROR");
}
