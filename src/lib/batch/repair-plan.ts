/**
 * Batch repair's own `PlanFn` — the exact same `analyzeSTLDiagnostics()`
 * + `planRepair()` pair the single-file STL Repair page already uses in
 * its own "plan" mode (`stl-repair.worker.ts`'s `mode: "plan"` path),
 * called directly here rather than through a worker (see
 * `batch-repair-integration.test.ts`'s own doc comment for why that's
 * the right boundary to mock in this test environment). Planning NEVER
 * mutates — it only reads diagnostics and decides what WOULD run.
 */
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { planRepair } from "../stl-repair/plan";
import { toSTLRepairSafeError } from "../stl-repair/errors";
import type { RepairPlan, RepairSettings } from "../stl-repair/types";
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";

export type RepairEligibility = "already-valid" | "eligible" | "unresolved-risk";

export interface BatchRepairPlanSummary {
  detectedIssues: string[];
  plannedOperations: string[];
  skippedOperations: string[];
  preset: RepairSettings["preset"];
  weldTolerance: number | null;
  shellCleanupPolicy: string;
  eligibility: RepairEligibility;
  warnings: string[];
}

function describeIssues(diagnostics: STLDiagnosticsReport): string[] {
  const issues: string[] = [];
  if (diagnostics.boundaryEdgeCount > 0) issues.push(`${diagnostics.boundaryEdgeCount} open boundary edge(s)`);
  if (diagnostics.nonManifoldEdgeCount > 0) issues.push(`${diagnostics.nonManifoldEdgeCount} non-manifold edge(s)`);
  if (diagnostics.windingConflictEdgeCount > 0) issues.push(`${diagnostics.windingConflictEdgeCount} winding-conflict edge(s)`);
  if (diagnostics.sameWindingDuplicateFaceCount + diagnostics.reverseWindingDuplicateFaceCount > 0) {
    issues.push(`${diagnostics.sameWindingDuplicateFaceCount + diagnostics.reverseWindingDuplicateFaceCount} duplicate face(s)`);
  }
  if (diagnostics.inwardShellCount > 0) issues.push(`${diagnostics.inwardShellCount} inward-oriented shell(s)`);
  return issues;
}

/**
 * A genuine non-manifold edge (more than two triangles sharing it) is
 * never resolved by any repair operation this pipeline offers — only
 * duplicate/degenerate-triangle cleanup, winding correction, hole
 * filling, and shell orientation, none of which target non-manifold
 * topology itself (this project's own documented policy — see
 * `docs/ARCHITECTURE.md`). So its presence means "unresolved risk"
 * regardless of what else the plan happens to fix on the same mesh.
 */
function estimateEligibility(diagnostics: STLDiagnosticsReport, _plan: RepairPlan): RepairEligibility {
  if (diagnostics.verdict === "watertight") return "already-valid";
  if (diagnostics.nonManifoldEdgeCount > 0) return "unresolved-risk";
  return "eligible";
}

function describeShellCleanupPolicy(settings: RepairSettings): string {
  if (!settings.removeSmallShells.enabled) return "disabled";
  return `${settings.removeSmallShells.criterion} below ${settings.removeSmallShells.threshold}`;
}

export function summarizeRepairPlan(plan: RepairPlan, diagnostics: STLDiagnosticsReport): BatchRepairPlanSummary {
  return {
    detectedIssues: describeIssues(diagnostics),
    plannedOperations: plan.steps.filter((s) => s.willRun).map((s) => s.operation),
    skippedOperations: plan.steps.filter((s) => !s.willRun).map((s) => s.operation),
    preset: plan.settings.preset,
    weldTolerance: plan.settings.weld.enabled ? plan.settings.weld.toleranceAbs : null,
    shellCleanupPolicy: describeShellCleanupPolicy(plan.settings),
    eligibility: estimateEligibility(diagnostics, plan),
    warnings: [],
  };
}

export async function planRepairFile(file: File, settings: RepairSettings): Promise<BatchRepairPlanSummary> {
  try {
    const buffer = await file.arrayBuffer();
    const parsed = parseSTL(buffer, DEFAULT_STL_LIMITS);
    const diagnostics = await analyzeSTLDiagnostics(parsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, settings);
    return summarizeRepairPlan(plan, diagnostics);
  } catch (err) {
    // Rethrow as an already-safe error — `PlanWorkflow.planAll()` uses it
    // directly instead of collapsing it into a generic "Something went
    // wrong.", so a budget/limit-exceeded file explains itself.
    throw toSTLRepairSafeError(err);
  }
}
