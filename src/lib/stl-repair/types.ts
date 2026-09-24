import type { STLDiagnosticsLimits, STLDiagnosticsReport } from "../stl-diagnostics/types";

export type RepairPreset = "safe" | "standard" | "custom";

export type SmallShellCriterion = "triangle-count" | "relative-area" | "absolute-diagonal";

export interface SmallShellSettings {
  enabled: boolean;
  criterion: SmallShellCriterion;
  /** Meaning depends on `criterion`: a triangle count, a 0..1 fraction of the largest shell's own surface area, or an absolute model-unit bounding-box diagonal. */
  threshold: number;
}

export interface WeldSettings {
  enabled: boolean;
  /** Absolute, in model units — STL has no declared unit, so this is never labelled mm/cm/in. Always the resolved, displayed value; never silently changed between preview and export. */
  toleranceAbs: number;
}

export interface RepairSettings {
  preset: RepairPreset;
  weld: WeldSettings;
  removeExactDegenerates: boolean;
  removeNearZeroDegenerates: boolean;
  removeDuplicateFaces: boolean;
  correctWinding: boolean;
  orientOutwardClosedShells: boolean;
  fillEligibleHoles: boolean;
  removeSmallShells: SmallShellSettings;
}

export interface RepairLimits {
  diagnostics: STLDiagnosticsLimits;
  maxWeldCandidates: number;
  maxWeldGridCells: number;
  minToleranceAbs: number;
  maxToleranceRatio: number; // relative to the model's own bounding-box diagonal
  maxLoopVertexCount: number;
  maxLoopPerimeterRatio: number; // relative to the model's own bounding-box diagonal
  maxLoopAreaRatio: number; // relative to the model's own bounding-box diagonal squared
  maxPlanarityDeviationRatio: number;
  maxPatchTrianglesPerLoop: number;
  maxHolesFilled: number;
  maxShellsConsideredForRemoval: number;
  maxOutputTriangles: number;
  maxOutputBytes: number;
  maxOverlaySamplesPerCategory: number;
  maxAnalysisMs: number;
}

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  diagnostics: {
    maxUniqueVertices: 3_000_000,
    maxEdgeRecords: 9_000_000,
    maxBoundaryComponents: 5_000,
    maxSampleVerticesPerBoundaryComponent: 50,
    maxDuplicateFaceGroups: 5_000,
    maxTriangleIndicesPerDuplicateGroup: 20,
    maxDetailedShells: 500,
    maxSpatialIndexTargetTrianglesPerCell: 8,
    maxSpatialIndexGridCells: 2_000_000,
    maxCandidateIntersectionPairs: 2_000_000,
    maxSelfIntersectionSamplePairs: 200,
    maxOverlaySamplesPerCategory: 5_000,
    maxAnalysisMs: 20_000,
  },
  maxWeldCandidates: 3_000_000,
  maxWeldGridCells: 2_000_000,
  minToleranceAbs: 1e-9,
  maxToleranceRatio: 0.02,
  maxLoopVertexCount: 500,
  maxLoopPerimeterRatio: 3,
  maxLoopAreaRatio: 1,
  maxPlanarityDeviationRatio: 0.05,
  maxPatchTrianglesPerLoop: 2_000,
  maxHolesFilled: 2_000,
  maxShellsConsideredForRemoval: 5_000,
  maxOutputTriangles: 6_000_000,
  maxOutputBytes: 400 * 1024 * 1024,
  maxOverlaySamplesPerCategory: 5_000,
  maxAnalysisMs: 30_000,
};

export function defaultWeldTolerance(boundingBoxDiagonal: number): number {
  return Math.max(boundingBoxDiagonal * 1e-4, DEFAULT_REPAIR_LIMITS.minToleranceAbs);
}

export function safePreset(): RepairSettings {
  return {
    preset: "safe",
    weld: { enabled: false, toleranceAbs: 0 },
    removeExactDegenerates: true,
    removeNearZeroDegenerates: false,
    removeDuplicateFaces: true,
    correctWinding: true,
    orientOutwardClosedShells: true,
    fillEligibleHoles: true,
    removeSmallShells: { enabled: false, criterion: "triangle-count", threshold: 0 },
  };
}

export function standardPreset(boundingBoxDiagonal: number): RepairSettings {
  return {
    preset: "standard",
    weld: { enabled: true, toleranceAbs: defaultWeldTolerance(boundingBoxDiagonal) },
    removeExactDegenerates: true,
    removeNearZeroDegenerates: true,
    removeDuplicateFaces: true,
    correctWinding: true,
    orientOutwardClosedShells: true,
    fillEligibleHoles: true,
    removeSmallShells: { enabled: false, criterion: "relative-area", threshold: 0.01 },
  };
}

// --- Plan --------------------------------------------------------------

export type RepairOperation =
  | "weld-vertices"
  | "remove-repeated-vertex-triangles"
  | "remove-exact-zero-area-triangles"
  | "remove-near-zero-area-triangles"
  | "remove-same-winding-duplicate-faces"
  | "remove-reverse-winding-duplicate-faces"
  | "correct-winding"
  | "orient-outward-closed-shells"
  | "fill-eligible-holes"
  | "remove-small-shells";

export interface RepairPlanStep {
  operation: RepairOperation;
  willRun: boolean;
  reason: string;
}

export interface RepairPlan {
  settings: RepairSettings;
  steps: RepairPlanStep[];
  originalSummary: DiagnosticsSummary;
}

// --- Result --------------------------------------------------------------

export interface DiagnosticsSummary {
  verdict: STLDiagnosticsReport["verdict"];
  triangleCount: number;
  validTriangleCount: number;
  uniqueVertexPositionCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  windingConflictEdgeCount: number;
  duplicateFaceCount: number;
  degenerateTriangleCount: number;
  shellCount: number;
  inwardShellCount: number;
  selfIntersectionStatus: "completed" | "not-checked";
  selfIntersectionCount: number;
}

export function summarizeDiagnostics(report: STLDiagnosticsReport): DiagnosticsSummary {
  return {
    verdict: report.verdict,
    triangleCount: report.triangleCount,
    validTriangleCount: report.validTriangleCount,
    uniqueVertexPositionCount: report.uniqueVertexPositionCount,
    boundaryEdgeCount: report.boundaryEdgeCount,
    nonManifoldEdgeCount: report.nonManifoldEdgeCount,
    windingConflictEdgeCount: report.windingConflictEdgeCount,
    duplicateFaceCount: report.sameWindingDuplicateFaceCount + report.reverseWindingDuplicateFaceCount,
    degenerateTriangleCount: report.degenerateTriangleCount,
    shellCount: report.shellCount,
    inwardShellCount: report.inwardShellCount,
    selfIntersectionStatus: report.selfIntersections.status,
    selfIntersectionCount: report.selfIntersections.intersectingPairCount,
  };
}

export type RepairOutcome = "fully-repaired" | "improved" | "unchanged" | "partially-repaired" | "unable-to-repair-safely" | "failed" | "cancelled";

export interface SkippedOperation {
  operation: RepairOperation | string;
  reason: string;
}

export interface HoleFillSkip {
  boundaryComponentId: number;
  reason: "not-a-closed-loop" | "vertex-count-limit" | "perimeter-limit" | "area-limit" | "planarity-limit" | "self-intersecting-boundary" | "triangulation-failed" | "patch-triangle-limit" | "hole-count-limit";
}

export interface RepairOverlayBuffers {
  /** Flat per-corner positions (9 floats/triangle) for triangles removed during repair (degenerate + duplicate). */
  removedTrianglePositions: Float32Array;
  /** Flat per-corner positions (9 floats/triangle) for triangles whose winding was flipped. */
  flippedTrianglePositions: Float32Array;
  /** Flat [x,y,z, ...] positions of vertices that were the target of a successful weld merge. */
  weldedVertexPositions: Float32Array;
  /** Flat per-corner positions (9 floats/triangle) for newly added hole-fill patch triangles. */
  filledHolePositions: Float32Array;
  /** Flat per-corner positions (9 floats/triangle) for triangles belonging to removed small shells. */
  removedShellPositions: Float32Array;
  /** Flat [x,y,z, x,y,z] line-segment endpoints for boundary edges that remain unresolved after repair. */
  unresolvedBoundaryEdgeLines: Float32Array;
  unresolvedNonManifoldEdgeLines: Float32Array;
  /** Flat per-corner positions (9 floats/triangle) for triangles involved in a remaining, unresolved self-intersection. */
  unresolvedSelfIntersectionPositions: Float32Array;
  truncated: Record<string, boolean>;
}

export interface RepairStageTiming {
  stage: string;
  durationMs: number;
}

export interface RepairResult {
  outcome: RepairOutcome;
  plan: RepairPlan;
  before: DiagnosticsSummary;
  after: DiagnosticsSummary | null;

  attemptedOperations: RepairOperation[];
  successfulOperations: RepairOperation[];
  skippedOperations: SkippedOperation[];
  unresolvedProblems: string[];
  holeFillSkips: HoleFillSkip[];

  verticesBefore: number;
  verticesAfter: number;
  trianglesBefore: number;
  trianglesAfter: number;

  verticesWelded: number;
  trianglesRemovedByCategory: {
    repeatedVertex: number;
    exactZeroArea: number;
    nearZeroArea: number;
    collapsedByWelding: number;
    sameWindingDuplicate: number;
    reverseWindingDuplicate: number;
  };
  trianglesFlipped: number;
  shellsReversed: number;
  holesFilled: number;
  trianglesAdded: number;
  shellsRemoved: number;

  nonManifoldEdgesBefore: number;
  nonManifoldEdgesAfter: number;
  boundaryEdgesBefore: number;
  boundaryEdgesAfter: number;
  windingConflictsBefore: number;
  windingConflictsAfter: number;
  selfIntersectionStatusBefore: "completed" | "not-checked";
  selfIntersectionStatusAfter: "completed" | "not-checked" | null;
  watertightVerdictBefore: STLDiagnosticsReport["verdict"];
  watertightVerdictAfter: STLDiagnosticsReport["verdict"] | null;

  /** The repaired binary STL, or `null` when the outcome is `"failed"`/`"cancelled"`/`"unable-to-repair-safely"` before any output was produced. */
  outputBytes: ArrayBuffer | null;
  overlays: RepairOverlayBuffers | null;

  stageTimings: RepairStageTiming[];
  warnings: { code: string; message: string }[];
}
