/**
 * Error translation for the STL Repair pipeline. Mirrors
 * `stl-diagnostics/errors.ts`'s own shape: this module owns no exception
 * class of its own for the repair-specific failure modes (invalid
 * settings, weld/topology/output ceilings, serialization/reparse/
 * verification failures) — it wraps `STLRepairException` for those, and
 * still translates the underlying STL parser's and diagnostics
 * pipeline's own exceptions unchanged, since a repair run re-parses and
 * re-diagnoses its own output using those same modules.
 */
import { createSafeError, type ErrorCode, type SafeError } from "../errors";
import { STLParseException, toSTLSafeError } from "../stl/errors";
import { toSTLDiagnosticsSafeError } from "../stl-diagnostics/errors";

export type STLRepairErrorCode = Extract<ErrorCode, `STLREPAIR_${string}`>;

export class STLRepairException extends Error {
  readonly code: STLRepairErrorCode;

  constructor(code: STLRepairErrorCode) {
    super(code);
    this.name = "STLRepairException";
    this.code = code;
  }
}

export function repairError(code: STLRepairErrorCode): STLRepairException {
  return new STLRepairException(code);
}

export function toSTLRepairSafeError(error: unknown): SafeError {
  if (error instanceof STLRepairException) return createSafeError(error.code);
  if (error instanceof STLParseException) return toSTLSafeError(error);
  // Covers the diagnostics-layer's own generic mesh-topology exceptions
  // (vertex/edge limits, analysis budget) unchanged, since repair calls
  // `analyzeSTLDiagnostics()` on both the original and the repaired mesh.
  const diagnosticsError = toSTLDiagnosticsSafeError(error);
  if (diagnosticsError.code !== "UNKNOWN_ERROR") return diagnosticsError;
  return createSafeError("UNKNOWN_ERROR");
}
