/**
 * Builds the explicit repair plan a user reviews BEFORE any geometry is
 * touched — this is what makes "never repair automatically before the
 * user sees the plan" possible: planning reads the original diagnostics
 * report and the chosen settings, and decides which operations WOULD
 * run and why (or why not), without mutating anything.
 */
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";
import { summarizeDiagnostics, type RepairOperation, type RepairPlan, type RepairPlanStep, type RepairSettings } from "./types";

export function planRepair(diagnostics: STLDiagnosticsReport, settings: RepairSettings): RepairPlan {
  const steps: RepairPlanStep[] = [];

  const step = (operation: RepairOperation, willRun: boolean, reason: string): void => {
    steps.push({ operation, willRun, reason });
  };

  step("weld-vertices", settings.weld.enabled, settings.weld.enabled ? `Merging vertices within ${settings.weld.toleranceAbs} model units.` : "Tolerance welding is not enabled for this preset.");

  step(
    "remove-repeated-vertex-triangles",
    settings.removeExactDegenerates && diagnostics.repeatedVertexTriangleCount > 0,
    settings.removeExactDegenerates
      ? diagnostics.repeatedVertexTriangleCount > 0
        ? `${diagnostics.repeatedVertexTriangleCount} repeated-vertex triangle(s) found.`
        : "No repeated-vertex triangles found."
      : "Exact-degenerate removal is disabled.",
  );
  step(
    "remove-exact-zero-area-triangles",
    settings.removeExactDegenerates && diagnostics.exactZeroAreaTriangleCount > 0,
    settings.removeExactDegenerates
      ? diagnostics.exactZeroAreaTriangleCount > 0
        ? `${diagnostics.exactZeroAreaTriangleCount} exact-zero-area triangle(s) found.`
        : "No exact-zero-area triangles found."
      : "Exact-degenerate removal is disabled.",
  );
  step(
    "remove-near-zero-area-triangles",
    settings.removeNearZeroDegenerates && diagnostics.nearZeroAreaTriangleCount > 0,
    settings.removeNearZeroDegenerates
      ? diagnostics.nearZeroAreaTriangleCount > 0
        ? `${diagnostics.nearZeroAreaTriangleCount} near-zero-area triangle(s) found.`
        : "No near-zero-area triangles found."
      : "Near-zero-area removal is disabled for this preset — enable it in Custom mode if needed.",
  );

  step(
    "remove-same-winding-duplicate-faces",
    settings.removeDuplicateFaces && diagnostics.sameWindingDuplicateFaceCount > 0,
    settings.removeDuplicateFaces
      ? diagnostics.sameWindingDuplicateFaceCount > 0
        ? `${diagnostics.sameWindingDuplicateFaceCount} same-winding duplicate face(s) found.`
        : "No same-winding duplicate faces found."
      : "Duplicate-face removal is disabled.",
  );
  step(
    "remove-reverse-winding-duplicate-faces",
    settings.removeDuplicateFaces && diagnostics.reverseWindingDuplicateFaceCount > 0,
    settings.removeDuplicateFaces
      ? diagnostics.reverseWindingDuplicateFaceCount > 0
        ? `${diagnostics.reverseWindingDuplicateFaceCount} reverse-winding duplicate face(s) found.`
        : "No reverse-winding duplicate faces found."
      : "Duplicate-face removal is disabled.",
  );

  step(
    "correct-winding",
    settings.correctWinding && diagnostics.windingConflictEdgeCount > 0,
    settings.correctWinding
      ? diagnostics.windingConflictEdgeCount > 0
        ? `${diagnostics.windingConflictEdgeCount} winding-conflict edge(s) found.`
        : "No winding conflicts found."
      : "Winding correction is disabled.",
  );
  step(
    "orient-outward-closed-shells",
    settings.orientOutwardClosedShells && diagnostics.inwardShellCount > 0,
    settings.orientOutwardClosedShells
      ? diagnostics.inwardShellCount > 0
        ? `${diagnostics.inwardShellCount} inward-oriented closed shell(s) found.`
        : "No inward-oriented closed shells found."
      : "Outward re-orientation is disabled.",
  );
  step(
    "fill-eligible-holes",
    settings.fillEligibleHoles && diagnostics.closedLoopBoundaryCount > 0,
    settings.fillEligibleHoles
      ? diagnostics.closedLoopBoundaryCount > 0
        ? `${diagnostics.closedLoopBoundaryCount} closed boundary loop(s) eligible for filling — final eligibility is confirmed per-loop against size/planarity limits during repair.`
        : "No closed boundary loops found."
      : "Hole filling is disabled.",
  );
  step(
    "remove-small-shells",
    settings.removeSmallShells.enabled && diagnostics.shellCount > 1,
    settings.removeSmallShells.enabled
      ? diagnostics.shellCount > 1
        ? `${diagnostics.shellCount} shells present — candidates will be selected by ${settings.removeSmallShells.criterion} against a threshold of ${settings.removeSmallShells.threshold}.`
        : "Only one shell present — nothing to remove."
      : "Small-shell removal is not enabled.",
  );

  return { settings, steps, originalSummary: summarizeDiagnostics(diagnostics) };
}
