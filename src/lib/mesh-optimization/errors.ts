/**
 * Error translation for the STL Optimization pipeline. Mirrors
 * `stl-repair/errors.ts`'s own shape: wraps `STLOptimizeException` for
 * optimization-specific failures, and still translates the underlying
 * STL parser's and diagnostics pipeline's own exceptions unchanged, since
 * an optimization run re-parses and re-diagnoses its own output using
 * those same modules.
 */
import { createSafeError, type ErrorCode, type SafeError } from "../errors";
import { STLParseException, toSTLSafeError } from "../stl/errors";
import { toSTLDiagnosticsSafeError } from "../stl-diagnostics/errors";

export type STLOptimizeErrorCode = Extract<ErrorCode, `STLOPT_${string}`>;

export class STLOptimizeException extends Error {
  readonly code: STLOptimizeErrorCode;

  constructor(code: STLOptimizeErrorCode) {
    super(code);
    this.name = "STLOptimizeException";
    this.code = code;
  }
}

export function optimizeError(code: STLOptimizeErrorCode): STLOptimizeException {
  return new STLOptimizeException(code);
}

export function toSTLOptimizeSafeError(error: unknown): SafeError {
  if (error instanceof STLOptimizeException) return createSafeError(error.code);
  if (error instanceof STLParseException) return toSTLSafeError(error);
  const diagnosticsError = toSTLDiagnosticsSafeError(error);
  if (diagnosticsError.code !== "UNKNOWN_ERROR") return diagnosticsError;
  return createSafeError("UNKNOWN_ERROR");
}
