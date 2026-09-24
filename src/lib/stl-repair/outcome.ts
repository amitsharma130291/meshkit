/**
 * The honest outcome-state policy. Kept as one small, pure, fully-tested
 * function — same rationale as `stl-diagnostics/verdict.ts`'s own
 * `computeVerdict()`: the whole point of an outcome claim is that its
 * rule is visible and auditable in one place.
 *
 * "fully-repaired" requires the AFTER diagnostics to actually satisfy
 * strict watertightness AND a COMPLETED self-intersection check — never
 * just that repair operations ran without throwing. If the after-state's
 * self-intersection check itself couldn't complete, the outcome is
 * capped at `"improved"` even when every other count is zero, since this
 * phase can never claim "no self-intersections" without having actually
 * verified it (see `stl-diagnostics/verdict.ts`'s own identical policy).
 */
import type { DiagnosticsSummary, RepairOutcome, SkippedOperation } from "./types";

export interface DetermineOutcomeInput {
  before: DiagnosticsSummary;
  after: DiagnosticsSummary;
  skippedOperations: SkippedOperation[];
  unresolvedProblems: string[];
}

function problemCount(s: DiagnosticsSummary): number {
  return (
    s.boundaryEdgeCount +
    s.nonManifoldEdgeCount +
    s.windingConflictEdgeCount +
    s.duplicateFaceCount +
    (s.selfIntersectionStatus === "completed" ? s.selfIntersectionCount : 0)
  );
}

export function determineOutcome(input: DetermineOutcomeInput): RepairOutcome {
  const { before, after, skippedOperations, unresolvedProblems } = input;

  const beforeProblems = problemCount(before);
  const afterProblems = problemCount(after);
  const selfIntersectionVerifiable = after.selfIntersectionStatus === "completed";

  // Facts that can improve independent of `problemCount` (which only
  // covers strict watertight-blocking issues): degenerate triangles
  // (Phase 5's own verdict never considers them) and inward-shell
  // orientation (a watertight-but-inverted shell is still "watertight",
  // so reversing it to outward doesn't move `problemCount` either).
  const nothingElseChanged = before.degenerateTriangleCount === after.degenerateTriangleCount && before.inwardShellCount === after.inwardShellCount;

  if (before.verdict === "watertight" && beforeProblems === 0 && afterProblems === 0 && nothingElseChanged) {
    return "unchanged";
  }

  // "Fully repaired" means a genuine before -> after transformation: the
  // mesh was NOT already watertight, and now it verifiably is. A mesh
  // that was already watertight and only had, say, a stray degenerate
  // triangle cleaned up or an inward shell reversed was never "broken"
  // in the watertightness sense — that's "improved," not "fully repaired."
  if (before.verdict !== "watertight" && after.verdict === "watertight" && selfIntersectionVerifiable && unresolvedProblems.length === 0) {
    return "fully-repaired";
  }

  const improved = afterProblems < beforeProblems || after.degenerateTriangleCount < before.degenerateTriangleCount || after.inwardShellCount < before.inwardShellCount;
  if (improved) {
    return skippedOperations.length > 0 || unresolvedProblems.length > 0 ? "partially-repaired" : "improved";
  }

  return "unable-to-repair-safely";
}
