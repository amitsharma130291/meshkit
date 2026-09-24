/**
 * Error translation for the STL Diagnostics pipeline. Unlike every other
 * domain's own `errors.ts`, this one doesn't define a single owning
 * exception class — `analyzeSTLDiagnostics()` sits on top of the
 * EXISTING STL parser (`stl/errors.ts`'s `STLParseException`) plus the
 * format-neutral mesh topology layer's own generic exceptions
 * (`mesh/errors.ts`'s `UniqueVertexLimitExceededError`, `mesh/edge-
 * incidence.ts`'s `EdgeRecordLimitExceededError`, `mesh/spatial-
 * index.ts`'s grid/candidate-pair limit errors — the latter two are
 * caught internally by `analyzeSelfIntersections()` itself and degrade
 * to a `"not-checked"` result, never reaching here). This module's job is
 * translating whichever of those a caller catches into one safe,
 * diagnostics-specific error.
 */
import { createSafeError, type SafeError } from "../errors";
import { STLParseException, toSTLSafeError } from "../stl/errors";
import { UniqueVertexLimitExceededError } from "../mesh/errors";
import { EdgeRecordLimitExceededError } from "../mesh/edge-incidence";

export class STLDiagnosticsBudgetExceededError extends Error {
  constructor() {
    super("stl diagnostics analysis budget exceeded");
    this.name = "STLDiagnosticsBudgetExceededError";
  }
}

export function toSTLDiagnosticsSafeError(error: unknown): SafeError {
  if (error instanceof STLParseException) return toSTLSafeError(error);
  if (error instanceof UniqueVertexLimitExceededError) return createSafeError("STLDIAG_VERTEX_LIMIT_EXCEEDED");
  if (error instanceof EdgeRecordLimitExceededError) return createSafeError("STLDIAG_EDGE_LIMIT_EXCEEDED");
  if (error instanceof STLDiagnosticsBudgetExceededError) return createSafeError("STLDIAG_ANALYSIS_BUDGET_EXCEEDED");
  return createSafeError("UNKNOWN_ERROR");
}
