/**
 * Eligibility classification and the planned-operations summary shown to
 * the user before any mutation runs — mirrors `stl-repair/plan.ts`'s own
 * "analyze, then plan, then show the plan" shape. Classification never
 * mutates the mesh and never silently repairs anything; a mesh with
 * degenerate/duplicate faces is directed to STL Repair, never
 * auto-cleaned inside the optimizer.
 */
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";
import { QUALITY_PRESETS, resolveTargetTriangleCount, summarizeDiagnostics, type DiagnosticsSummary, type EligibilityClass, type OptimizeSettings } from "./types";

export interface EligibilityResult {
  eligibility: EligibilityClass;
  reasons: string[];
}

export interface OptimizePlan {
  eligibility: EligibilityClass;
  reasons: string[];
  before: DiagnosticsSummary;
  requestedTargetTriangleCount: number;
  /** The preset's own surface-area/volume quality-policy limits (never a manufacturing tolerance) — shown before anything runs, so exceeding one later is never a surprise. */
  appliedThresholds: { maxSurfaceAreaChangePercent: number; maxVolumeChangePercent: number };
}

/** The "show the plan before running" preview — parses/diagnoses but never mutates anything, mirroring `stl-repair/plan.ts#planRepair()`'s own non-mutating contract. */
export function planOptimize(report: STLDiagnosticsReport, settings: OptimizeSettings, minTrianglesPerShellFloor: number): OptimizePlan {
  const { eligibility, reasons } = classifyEligibility(report);
  const minTrianglesPerShell = settings.minTrianglesPerShell ?? minTrianglesPerShellFloor;
  const requestedTargetTriangleCount = resolveTargetTriangleCount(report.validTriangleCount, settings.target, minTrianglesPerShell);
  const preset = QUALITY_PRESETS[settings.preset];
  return {
    eligibility,
    reasons,
    before: summarizeDiagnostics(report),
    requestedTargetTriangleCount,
    appliedThresholds: { maxSurfaceAreaChangePercent: preset.maxSurfaceAreaChangePercent, maxVolumeChangePercent: preset.maxVolumeChangePercent },
  };
}

/**
 * Precedence, most severe first (only the FIRST matching rule sets the
 * class — later, less-severe findings are still listed in `reasons` when
 * relevant, but never override a more severe classification):
 * 1. non-manifold edges -> unsafe-to-simplify (no safe default collapse policy)
 * 2. a CONFIRMED self-intersection -> unsafe-to-simplify (never simplify over unresolved bad geometry)
 * 3. degenerate/duplicate faces -> repair-recommended (fix in STL Repair first)
 * 4. self-intersection check incomplete -> eligible-with-warnings (disclosed limitation)
 * 5. open boundary present -> eligible-with-warnings (boundary-preservation constraints apply)
 * 6. otherwise -> eligible
 */
export function classifyEligibility(report: STLDiagnosticsReport): EligibilityResult {
  const reasons: string[] = [];

  if (report.nonManifoldEdgeCount > 0) {
    reasons.push(`${report.nonManifoldEdgeCount} non-manifold edge(s) — this tool does not simplify non-manifold topology by default.`);
    return { eligibility: "unsafe-to-simplify", reasons };
  }

  if (report.selfIntersections.status === "completed" && report.selfIntersections.intersectingPairCount > 0) {
    reasons.push(`${report.selfIntersections.intersectingPairCount} confirmed self-intersecting triangle pair(s) — resolve these before simplifying.`);
    return { eligibility: "unsafe-to-simplify", reasons };
  }

  const duplicateFaceCount = report.sameWindingDuplicateFaceCount + report.reverseWindingDuplicateFaceCount;
  if (report.degenerateTriangleCount > 0 || duplicateFaceCount > 0) {
    if (report.degenerateTriangleCount > 0) reasons.push(`${report.degenerateTriangleCount} degenerate triangle(s) found.`);
    if (duplicateFaceCount > 0) reasons.push(`${duplicateFaceCount} duplicate face(s) found.`);
    reasons.push("Run STL Repair first, then re-open the result here.");
    return { eligibility: "repair-recommended", reasons };
  }

  if (report.selfIntersections.status !== "completed") {
    reasons.push("Self-intersection analysis did not complete for this model — simplification safety cannot be fully verified.");
  }
  if (report.boundaryEdgeCount > 0) {
    reasons.push(`${report.boundaryEdgeCount} boundary edge(s) — this is an open mesh; boundary-preservation constraints apply during simplification.`);
  }

  return { eligibility: reasons.length > 0 ? "eligible-with-warnings" : "eligible", reasons };
}
