import type { Bounds3 } from "../mesh/topology-types";
import type { BoundaryComponentKind } from "../mesh/boundary-components";
import type { ShellOrientationVerdict } from "../mesh/orientation";
import type { STLParseResult } from "../stl/types";

export type WatertightVerdict = "watertight" | "not-watertight" | "invalid-topology" | "indeterminate";

/** Stable, documented reason codes explaining a verdict — never a free-form string, so the UI can localize/style each one consistently. See `verdict.ts` for the exact policy each code corresponds to. */
export type VerdictReasonCode =
  | "no-valid-triangles"
  | "has-boundary-edges"
  | "has-non-manifold-edges"
  | "has-winding-conflicts"
  | "has-duplicate-faces"
  | "self-intersections-found"
  | "self-intersections-not-checked"
  | "all-checks-passed";

export interface ShellSummary {
  id: number;
  triangleCount: number;
  bounds: Bounds3;
  surfaceArea: number;
  closed: boolean;
  consistentlyOrientable: boolean;
  /** `null` exactly when the shell is open, inconsistently orientable, or has a near-zero volume — see `mesh/orientation.ts`'s own documented policy. */
  signedVolume: number | null;
  orientation: ShellOrientationVerdict;
}

export interface BoundaryComponentSummary {
  id: number;
  kind: BoundaryComponentKind;
  edgeCount: number;
  vertexCount: number;
}

export interface SelfIntersectionSummary {
  status: "completed" | "not-checked";
  intersectingPairCount: number;
  involvedTriangleCount: number;
  /** Bounded sample of `{triangleA, triangleB}` pairs — never every pair for a heavily self-intersecting mesh. */
  samplePairs: { triangleA: number; triangleB: number }[];
}

export type SlicerRiskSeverity = "info" | "warning" | "risk";

export interface SlicerRiskFlag {
  code: string;
  severity: SlicerRiskSeverity;
  message: string;
}

export interface DiagnosticsWarning {
  code: string;
  message: string;
}

/** Bounded, render-ready overlay buffers for the viewer — never the full defective-edge/pair list, only what's needed to draw a representative highlight. */
export interface DiagnosticsOverlayBuffers {
  /** Flat [x,y,z, x,y,z] line-segment endpoint pairs, one segment per boundary edge sample. */
  boundaryEdgeLines: Float32Array;
  nonManifoldEdgeLines: Float32Array;
  windingConflictEdgeLines: Float32Array;
  /** Flat per-corner positions (9 floats/triangle) for the sampled degenerate triangles — rendered as thin, visible slivers regardless of their true (near-zero) size is a UI concern, not this buffer's. */
  degenerateTrianglePositions: Float32Array;
  duplicateFacePositions: Float32Array;
  selfIntersectingTrianglePositions: Float32Array;
  /** `shellId -> flat per-corner positions (9 floats/triangle)` for a bounded number of shells, for the "highlight one shell" toggle. */
  shellPositionsById: Record<number, Float32Array>;
  truncated: {
    boundaryEdgeLines: boolean;
    nonManifoldEdgeLines: boolean;
    windingConflictEdgeLines: boolean;
    degenerateTriangles: boolean;
    duplicateFaces: boolean;
    selfIntersectingTriangles: boolean;
    shells: boolean;
  };
}

export interface STLDiagnosticsStageTiming {
  stage: string;
  durationMs: number;
}

export interface STLDiagnosticsReport {
  verdict: WatertightVerdict;
  reasonCodes: VerdictReasonCode[];
  slicerRisk: SlicerRiskFlag[];

  triangleCount: number;
  validTriangleCount: number;
  degenerateTriangleCount: number;
  repeatedVertexTriangleCount: number;
  exactZeroAreaTriangleCount: number;
  nearZeroAreaTriangleCount: number;

  sourceVertexSlotCount: number;
  uniqueVertexPositionCount: number;
  duplicateCoordinateReferenceCount: number;

  sameWindingDuplicateFaceCount: number;
  reverseWindingDuplicateFaceCount: number;
  duplicateFaceGroupCount: number;
  duplicateFaceGroupsTruncated: boolean;

  boundaryEdgeCount: number;
  boundaryComponents: BoundaryComponentSummary[];
  boundaryComponentsTruncated: boolean;
  closedLoopBoundaryCount: number;
  openChainBoundaryCount: number;
  branchedBoundaryCount: number;
  nonSimpleBoundaryCount: number;

  manifoldEdgeCount: number;
  nonManifoldEdgeCount: number;
  windingConflictEdgeCount: number;

  shellCount: number;
  shells: ShellSummary[];
  shellsTruncated: boolean;
  inwardShellCount: number;

  selfIntersections: SelfIntersectionSummary;

  bounds: Bounds3;
  surfaceArea: number;
  /** Sum of every closed, consistently-orientable, non-near-zero shell's own signed volume — `null` when no shell qualifies. Never a naive sum across open or inconsistently-oriented shells. */
  totalEnclosedVolume: number | null;

  stageTimings: STLDiagnosticsStageTiming[];
  warnings: DiagnosticsWarning[];
  overlays: DiagnosticsOverlayBuffers;
}

export interface STLDiagnosticsLimits {
  maxUniqueVertices: number;
  maxEdgeRecords: number;
  maxBoundaryComponents: number;
  maxSampleVerticesPerBoundaryComponent: number;
  maxDuplicateFaceGroups: number;
  maxTriangleIndicesPerDuplicateGroup: number;
  maxDetailedShells: number;
  maxSpatialIndexTargetTrianglesPerCell: number;
  maxSpatialIndexGridCells: number;
  maxCandidateIntersectionPairs: number;
  maxSelfIntersectionSamplePairs: number;
  /** Bounded sample sizes for each overlay buffer category — independent of how many the analysis itself finds. */
  maxOverlaySamplesPerCategory: number;
  /** Soft wall-clock budget (milliseconds) checked between major stages — see `analyze.ts`'s own doc comment for exactly which stages this can skip. */
  maxAnalysisMs: number;
}

/**
 * The worker's own final result: the ORIGINAL parsed STL geometry
 * (unchanged from `parseSTL()` — the base model the viewport renders,
 * exactly as `stl-viewer.worker.ts` already produces) alongside the
 * diagnostics report (which supplies the issue-overlay geometry and
 * every count/verdict). Kept as two clearly separate top-level fields
 * rather than merged into one shape, since "the model" and "what's wrong
 * with it" are different concerns with different lifetimes in the UI.
 */
export interface STLDiagnosticsWorkerResult {
  stl: STLParseResult;
  report: STLDiagnosticsReport;
}

export const DEFAULT_STL_DIAGNOSTICS_LIMITS: STLDiagnosticsLimits = {
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
};
