/**
 * The honest outcome-state policy for STL Optimization — same rationale
 * as `stl-repair/outcome.ts`'s own `determineOutcome()`: one small, pure,
 * fully-tested function so the rule behind every outcome claim is
 * auditable in one place. A verification-invariant violation (shell
 * count changed, non-manifold/boundary/winding/duplicate/degenerate
 * counts increased, or a watertight input became non-watertight) is
 * always reported as `verification-failed` — this should never actually
 * happen given `collapse-validation.ts`'s own safety policy, but the
 * outcome layer never assumes that policy worked; it checks the REAL
 * reparsed-and-rediagnosed output.
 */
import type { DiagnosticsSummary, OptimizeOutcome, ThresholdCheckResult } from "./types";

export interface DetermineOutcomeInput {
  before: DiagnosticsSummary;
  after: DiagnosticsSummary | null;
  stopReason: string;
  requestedTargetTriangleCount: number;
  achievedTriangleCount: number;
  deviationCompleted: boolean;
  unresolvedProblems: string[];
  /** Omitted defaults to "passed" — never a false failure for callers that haven't computed it yet. */
  thresholdCheck?: ThresholdCheckResult;
}

function invariantsHold(before: DiagnosticsSummary, after: DiagnosticsSummary): boolean {
  if (before.verdict === "watertight" && after.verdict !== "watertight") return false;
  if (after.shellCount !== before.shellCount) return false;
  if (after.boundaryEdgeCount > before.boundaryEdgeCount) return false;
  if (after.nonManifoldEdgeCount > before.nonManifoldEdgeCount) return false;
  if (after.windingConflictEdgeCount > before.windingConflictEdgeCount) return false;
  if (after.duplicateFaceCount > before.duplicateFaceCount) return false;
  if (after.degenerateTriangleCount > before.degenerateTriangleCount) return false;
  if (after.selfIntersectionStatus === "completed" && before.selfIntersectionStatus === "completed" && after.selfIntersectionCount > before.selfIntersectionCount) {
    return false;
  }
  return true;
}

export function determineOutcome(input: DetermineOutcomeInput): OptimizeOutcome {
  const { before, after, stopReason, requestedTargetTriangleCount, achievedTriangleCount, deviationCompleted, unresolvedProblems, thresholdCheck } = input;

  if (stopReason === "cancelled") return "cancelled";
  if (!after) return "verification-failed";
  if (!invariantsHold(before, after)) return "verification-failed";
  // A preset's own quality-policy threshold (surface-area/volume drift) is a real, detected
  // policy violation on the VERIFIED output — never silently reported as target-achieved/reduced-safely.
  if (thresholdCheck?.exceededSurfaceAreaThreshold || thresholdCheck?.exceededVolumeThreshold) return "verification-failed";

  const selfIntersectionVerifiable = after.selfIntersectionStatus === "completed";
  const targetMet = achievedTriangleCount <= requestedTargetTriangleCount;

  if (targetMet && selfIntersectionVerifiable && deviationCompleted && unresolvedProblems.length === 0) {
    return "target-achieved";
  }

  if (!selfIntersectionVerifiable || !deviationCompleted) {
    return "verification-incomplete";
  }

  const anyReduction = achievedTriangleCount < before.triangleCount;
  if (anyReduction) return "partially-reduced";

  return "unchanged-no-safe-collapses";
}
