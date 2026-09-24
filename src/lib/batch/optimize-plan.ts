/**
 * Batch optimization's own `PlanFn` — the exact same
 * `analyzeSTLDiagnostics()` + `planOptimize()` pair the single-file STL
 * Optimization page already uses in its own "plan" mode. A percentage
 * target is resolved to an EXPLICIT per-file triangle count here (via
 * `planOptimize()`'s own `resolveTargetTriangleCount`), since files in
 * one batch can have wildly different source triangle counts.
 */
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { planOptimize } from "../mesh-optimization/plan";
import { toSTLOptimizeSafeError } from "../mesh-optimization/errors";
import { DEFAULT_OPTIMIZE_LIMITS, type EligibilityClass, type OptimizeSettings } from "../mesh-optimization/types";

export interface BatchOptimizePlanSummary {
  eligibility: EligibilityClass;
  reasons: string[];
  sourceTriangleCount: number;
  targetTriangleCount: number;
  preset: OptimizeSettings["preset"];
  appliedThresholds: { maxSurfaceAreaChangePercent: number; maxVolumeChangePercent: number };
}

export async function planOptimizeFile(file: File, settings: OptimizeSettings): Promise<BatchOptimizePlanSummary> {
  try {
    const buffer = await file.arrayBuffer();
    const parsed = parseSTL(buffer, DEFAULT_STL_LIMITS);
    const diagnostics = await analyzeSTLDiagnostics(parsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planOptimize(diagnostics, settings, DEFAULT_OPTIMIZE_LIMITS.minTrianglesPerShellFloor);

    return {
      eligibility: plan.eligibility,
      reasons: plan.reasons,
      sourceTriangleCount: plan.before.triangleCount,
      targetTriangleCount: plan.requestedTargetTriangleCount,
      preset: settings.preset,
      appliedThresholds: plan.appliedThresholds,
    };
  } catch (err) {
    // Same reasoning as `planRepairFile` — preserve the specific reason
    // (e.g. an analysis time-budget ceiling) instead of a generic failure.
    throw toSTLOptimizeSafeError(err);
  }
}
