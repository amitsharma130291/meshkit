/**
 * Builds the downloadable JSON diagnostics report. Deliberately a
 * SUBSET of `STLDiagnosticsReport` — every result count, the verdict, the
 * slicer-risk summary, warnings and stage timings are included, but
 * nothing that could leak more than the user intended:
 *
 * - `overlays` (the render-ready geometry buffers) is never included —
 *   it's binary typed-array data for the viewer, not report content, and
 *   including it would balloon the file for no benefit to a human or
 *   automated reader of the report.
 * - No raw triangle/vertex coordinates, no raw file bytes.
 * - No STL header text (an STL's 80-byte binary header, or an ASCII
 *   file's `solid <name>` line, is arbitrary user-authored text this
 *   report never echoes back).
 * - No stack traces, no local file-system paths.
 * - The file name is included but sanitized to a bare display name (path
 *   separators stripped) — the browser's own File API never hands this
 *   code a full local path anyway, but this is defense in depth.
 */
import type { STLDiagnosticsLimits, STLDiagnosticsReport } from "./types";

export const STL_DIAGNOSTICS_REPORT_SCHEMA_VERSION = "1.0.0";
export const STL_DIAGNOSTICS_TOOL_VERSION = "1.0.0";

export interface DownloadableDiagnosticsReport {
  schemaVersion: string;
  toolVersion: string;
  generatedAt: string;
  file: { name: string; sizeBytes: number };
  analysisSettings: STLDiagnosticsLimits;
  verdict: STLDiagnosticsReport["verdict"];
  reasonCodes: STLDiagnosticsReport["reasonCodes"];
  slicerRisk: STLDiagnosticsReport["slicerRisk"];
  counts: {
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
    boundaryEdgeCount: number;
    closedLoopBoundaryCount: number;
    openChainBoundaryCount: number;
    branchedBoundaryCount: number;
    nonSimpleBoundaryCount: number;
    manifoldEdgeCount: number;
    nonManifoldEdgeCount: number;
    windingConflictEdgeCount: number;
    shellCount: number;
    inwardShellCount: number;
  };
  boundaryComponents: STLDiagnosticsReport["boundaryComponents"];
  shells: STLDiagnosticsReport["shells"];
  selfIntersections: { status: "completed" | "not-checked"; intersectingPairCount: number; involvedTriangleCount: number };
  geometry: { bounds: STLDiagnosticsReport["bounds"]; surfaceArea: number; totalEnclosedVolume: number | null };
  completedChecks: string[];
  skippedChecks: string[];
  stageTimingsMs: Record<string, number>;
  warnings: STLDiagnosticsReport["warnings"];
  limitations: string[];
}

const LIMITATIONS = [
  "Vertex identity uses exact float32 coordinate matching, never distance-tolerance welding — two positions that differ by even a tiny amount are treated as distinct vertices.",
  "Degenerate (zero- or near-zero-area) triangles are excluded from every topology, orientation and self-intersection check below.",
  "An inward-oriented shell is still topologically watertight — orientation and watertightness are reported as separate, independent facts.",
  "Passing every check here does not guarantee a model will print successfully, and failing one does not mean it cannot be sliced.",
];

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

export function buildDownloadableReport(report: STLDiagnosticsReport, limits: STLDiagnosticsLimits, fileName: string, fileSizeBytes: number): DownloadableDiagnosticsReport {
  const completedChecks: string[] = ["degenerate-triangles", "duplicate-faces", "boundary-edges", "boundary-components", "non-manifold-edges", "winding-conflicts", "shells", "orientation"];
  const skippedChecks: string[] = [];
  if (report.selfIntersections.status === "completed") completedChecks.push("self-intersections");
  else skippedChecks.push("self-intersections");

  const stageTimingsMs: Record<string, number> = {};
  for (const stage of report.stageTimings) stageTimingsMs[stage.stage] = stage.durationMs;

  return {
    schemaVersion: STL_DIAGNOSTICS_REPORT_SCHEMA_VERSION,
    toolVersion: STL_DIAGNOSTICS_TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    file: { name: sanitizeFileName(fileName), sizeBytes: fileSizeBytes },
    analysisSettings: limits,
    verdict: report.verdict,
    reasonCodes: report.reasonCodes,
    slicerRisk: report.slicerRisk,
    counts: {
      triangleCount: report.triangleCount,
      validTriangleCount: report.validTriangleCount,
      degenerateTriangleCount: report.degenerateTriangleCount,
      repeatedVertexTriangleCount: report.repeatedVertexTriangleCount,
      exactZeroAreaTriangleCount: report.exactZeroAreaTriangleCount,
      nearZeroAreaTriangleCount: report.nearZeroAreaTriangleCount,
      sourceVertexSlotCount: report.sourceVertexSlotCount,
      uniqueVertexPositionCount: report.uniqueVertexPositionCount,
      duplicateCoordinateReferenceCount: report.duplicateCoordinateReferenceCount,
      sameWindingDuplicateFaceCount: report.sameWindingDuplicateFaceCount,
      reverseWindingDuplicateFaceCount: report.reverseWindingDuplicateFaceCount,
      duplicateFaceGroupCount: report.duplicateFaceGroupCount,
      boundaryEdgeCount: report.boundaryEdgeCount,
      closedLoopBoundaryCount: report.closedLoopBoundaryCount,
      openChainBoundaryCount: report.openChainBoundaryCount,
      branchedBoundaryCount: report.branchedBoundaryCount,
      nonSimpleBoundaryCount: report.nonSimpleBoundaryCount,
      manifoldEdgeCount: report.manifoldEdgeCount,
      nonManifoldEdgeCount: report.nonManifoldEdgeCount,
      windingConflictEdgeCount: report.windingConflictEdgeCount,
      shellCount: report.shellCount,
      inwardShellCount: report.inwardShellCount,
    },
    boundaryComponents: report.boundaryComponents,
    shells: report.shells,
    selfIntersections: { status: report.selfIntersections.status, intersectingPairCount: report.selfIntersections.intersectingPairCount, involvedTriangleCount: report.selfIntersections.involvedTriangleCount },
    geometry: { bounds: report.bounds, surfaceArea: report.surfaceArea, totalEnclosedVolume: report.totalEnclosedVolume },
    completedChecks,
    skippedChecks,
    stageTimingsMs,
    warnings: report.warnings,
    limitations: LIMITATIONS,
  };
}
