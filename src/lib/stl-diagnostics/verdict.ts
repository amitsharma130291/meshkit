/**
 * The strict watertightness verdict and the separate, non-authoritative
 * slicer-risk summary. Kept in one small, pure, fully-tested module
 * deliberately — the whole point of a "verdict" is that its policy is
 * visible and auditable in one place, never scattered across the
 * orchestrator.
 *
 * Verdict states (exactly these four, never a numeric score):
 * - "invalid-topology": the mesh has no usable (non-degenerate) surface
 *   at all — there is nothing meaningful to certify one way or the other.
 * - "watertight": every strict criterion below holds.
 * - "not-watertight": at least one strict criterion has DEFINITE evidence
 *   against it (a real boundary edge exists, a real non-manifold edge
 *   exists, etc.) — the file's own topology already disqualifies it.
 * - "indeterminate": no DEFINITE failure evidence exists, but the
 *   self-intersection check itself could not be completed (a safety
 *   ceiling was hit) and the declared strict policy requires that check
 *   — there simply isn't enough evidence for a confident verdict either
 *   way.
 */
import type { STLDiagnosticsReport, VerdictReasonCode, WatertightVerdict, SlicerRiskFlag } from "./types";

/**
 * The strict watertight policy this phase declares and tests against:
 * zero boundary edges, zero non-manifold edges, zero winding-conflict
 * edges, zero duplicate/reverse-duplicate faces, AND (this flag) a
 * COMPLETED self-intersection check with zero disallowed intersections.
 * Documented as its own named constant specifically so the policy is
 * visible and testable, not an implicit assumption buried in the verdict
 * function's control flow.
 */
export const STRICT_WATERTIGHT_REQUIRES_NO_SELF_INTERSECTIONS = true;

export interface VerdictInput {
  validTriangleCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  windingConflictEdgeCount: number;
  sameWindingDuplicateFaceCount: number;
  reverseWindingDuplicateFaceCount: number;
  selfIntersections: { status: "completed" | "not-checked"; intersectingPairCount: number };
}

export function computeVerdict(input: VerdictInput): { verdict: WatertightVerdict; reasonCodes: VerdictReasonCode[] } {
  if (input.validTriangleCount === 0) {
    return { verdict: "invalid-topology", reasonCodes: ["no-valid-triangles"] };
  }

  const definiteFailures: VerdictReasonCode[] = [];
  if (input.boundaryEdgeCount > 0) definiteFailures.push("has-boundary-edges");
  if (input.nonManifoldEdgeCount > 0) definiteFailures.push("has-non-manifold-edges");
  if (input.windingConflictEdgeCount > 0) definiteFailures.push("has-winding-conflicts");
  if (input.sameWindingDuplicateFaceCount + input.reverseWindingDuplicateFaceCount > 0) definiteFailures.push("has-duplicate-faces");
  if (STRICT_WATERTIGHT_REQUIRES_NO_SELF_INTERSECTIONS && input.selfIntersections.status === "completed" && input.selfIntersections.intersectingPairCount > 0) {
    definiteFailures.push("self-intersections-found");
  }

  if (definiteFailures.length > 0) {
    return { verdict: "not-watertight", reasonCodes: definiteFailures };
  }

  if (STRICT_WATERTIGHT_REQUIRES_NO_SELF_INTERSECTIONS && input.selfIntersections.status === "not-checked") {
    return { verdict: "indeterminate", reasonCodes: ["self-intersections-not-checked"] };
  }

  return { verdict: "watertight", reasonCodes: ["all-checks-passed"] };
}

/**
 * A separate, purely additive list of print-relevant observations — never
 * a numeric score. Always accompanied (in the UI/report) by this exact
 * disclaimer set, since none of these flags individually determine
 * whether a model will actually slice or print successfully:
 */
export const SLICER_RISK_DISCLAIMERS = [
  "Passing these checks does not guarantee a model will print successfully.",
  "Failing one or more of these checks does not mean a model cannot be sliced — many slicers auto-repair minor issues.",
  "Wall thickness, physical scale, your printer's own limits, support requirements and manufacturing tolerances are outside what this checker evaluates.",
] as const;

export function computeSlicerRisk(report: Pick<STLDiagnosticsReport, "verdict" | "boundaryEdgeCount" | "closedLoopBoundaryCount" | "nonManifoldEdgeCount" | "windingConflictEdgeCount" | "inwardShellCount" | "shellCount" | "degenerateTriangleCount" | "selfIntersections" | "sameWindingDuplicateFaceCount" | "reverseWindingDuplicateFaceCount">): SlicerRiskFlag[] {
  const flags: SlicerRiskFlag[] = [];

  if (report.verdict === "not-watertight" || report.verdict === "invalid-topology") {
    flags.push({ code: "not-watertight", severity: "risk", message: "This model isn't watertight. Most slicers will warn, auto-repair, or produce unpredictable results." });
  }
  if (report.closedLoopBoundaryCount > 0) {
    flags.push({ code: "has-holes", severity: "risk", message: "One or more closed boundary loops were found — a likely sign of a hole in the surface." });
  }
  if (report.nonManifoldEdgeCount > 0) {
    flags.push({ code: "non-manifold-edges", severity: "risk", message: "Non-manifold edges were found (an edge shared by more than two triangles) — many slicers handle these unpredictably." });
  }
  if (report.windingConflictEdgeCount > 0) {
    flags.push({ code: "winding-conflicts", severity: "warning", message: "Some adjacent triangles disagree on winding direction — this can cause inside-out shading or lighting artifacts and may confuse a slicer's inside/outside test." });
  }
  if (report.inwardShellCount > 0) {
    flags.push({ code: "inward-shells", severity: "warning", message: "One or more closed shells appear inward-oriented (inverted normals) — some slicers treat this as solid, others as a hole." });
  }
  if (report.shellCount > 1) {
    flags.push({ code: "multiple-shells", severity: "info", message: `This model has ${report.shellCount} separate, disconnected pieces — confirm this is intentional (e.g. a multi-part model) rather than a fragmented single part.` });
  }
  if (report.degenerateTriangleCount > 0) {
    flags.push({ code: "degenerate-triangles", severity: "info", message: "This file contains degenerate (zero- or near-zero-area) triangles, which were excluded from every topology check above." });
  }
  if (report.sameWindingDuplicateFaceCount + report.reverseWindingDuplicateFaceCount > 0) {
    flags.push({ code: "duplicate-faces", severity: "warning", message: "Duplicate (stacked) triangles were found — some slicers render these correctly, others produce z-fighting artifacts." });
  }
  if (report.selfIntersections.status === "not-checked") {
    flags.push({ code: "self-intersections-not-checked", severity: "info", message: "This model was too complex to fully check for self-intersections within this checker's safety limits." });
  } else if (report.selfIntersections.intersectingPairCount > 0) {
    flags.push({ code: "self-intersections-found", severity: "risk", message: "Self-intersecting (overlapping) triangles were found — these can cause unpredictable slicing behavior." });
  }

  return flags;
}
