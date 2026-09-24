/**
 * Builds the downloadable JSON optimization report. Same safety posture
 * as `stl-repair/report.ts`: a deliberate SUBSET of `OptimizeResult` —
 * never `outputBytes`, never visualization buffers, never raw triangle
 * coordinates, the original file's own header text, a stack trace, or a
 * local path.
 */
import type { OptimizeLimits, OptimizeResult } from "./types";

export const STL_OPTIMIZE_REPORT_SCHEMA_VERSION = "1.0.0";
export const STL_OPTIMIZE_TOOL_VERSION = "1.0.0";

export interface DownloadableOptimizeReport {
  schemaVersion: string;
  toolVersion: string;
  generatedAt: string;
  file: { name: string; sizeBytes: number };
  settings: OptimizeResult["settings"];
  limits: OptimizeLimits;
  eligibility: OptimizeResult["eligibility"];
  outcome: OptimizeResult["outcome"];
  before: OptimizeResult["before"];
  after: OptimizeResult["after"];
  counts: {
    originalTriangleCount: number;
    requestedTargetTriangleCount: number;
    optimizedTriangleCount: number;
    requestedReductionPercent: number;
    achievedReductionPercent: number;
    originalBytes: number;
    optimizedBytes: number | null;
    actualBytesSaved: number | null;
    actualSizeReductionPercent: number | null;
    attemptedCollapses: number;
    acceptedCollapses: number;
    rejectedCollapsesByReason: OptimizeResult["rejectedCollapsesByReason"];
    shellCountBefore: number;
    shellCountAfter: number | null;
    boundaryEdgesBefore: number;
    boundaryEdgesAfter: number | null;
    nonManifoldEdgesBefore: number;
    nonManifoldEdgesAfter: number | null;
  };
  stopReason: string;
  deviation: OptimizeResult["deviation"];
  surfaceArea: { before: number; after: number; change: number; changePercent: number | null };
  volume: { before: number | null; after: number | null; change: number | null; changePercent: number | null; status: OptimizeResult["volumeStatus"]; reason?: string };
  appliedThresholds: OptimizeResult["appliedThresholds"];
  thresholdCheck: OptimizeResult["thresholdCheck"];
  stageTimingsMs: Record<string, number>;
  warnings: string[];
  unresolvedProblems: string[];
  limitations: string[];
}

const LIMITATIONS = [
  "This tool only simplifies mesh topology — it never guarantees printability, wall thickness, physical scale, or fitness for any particular printer.",
  "Deviation is a bounded SAMPLED measurement (source and optimized vertices and triangle centroids, checked against the other mesh's nearest surface point) — labelled \"sampled geometric deviation,\" never Hausdorff distance, since the full surface is never exhaustively checked.",
  "Self-intersection verification on the output may be incomplete for very dense or pathological meshes — when that happens, the result is never claimed as fully verified.",
  "Non-manifold input is never simplified by default — this tool detects and reports it, and directs the user to STL Repair first.",
  "\"Target achieved\" is only ever reported when the ACTUAL optimized output file was re-parsed and re-diagnosed clean against every safety invariant — never assumed from the collapse loop alone.",
  "Shell count is always preserved — this tool never deletes an entire disconnected shell, even a very small one, without the user explicitly requesting that as a separate operation in a future phase.",
];

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

export function buildDownloadableOptimizeReport(result: OptimizeResult, limits: OptimizeLimits, fileName: string, fileSizeBytes: number): DownloadableOptimizeReport {
  const stageTimingsMs: Record<string, number> = {};
  for (const s of result.stageTimings) stageTimingsMs[s.stage] = s.durationMs;

  return {
    schemaVersion: STL_OPTIMIZE_REPORT_SCHEMA_VERSION,
    toolVersion: STL_OPTIMIZE_TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    file: { name: sanitizeFileName(fileName), sizeBytes: fileSizeBytes },
    settings: result.settings,
    limits,
    eligibility: result.eligibility,
    outcome: result.outcome,
    before: result.before,
    after: result.after,
    counts: {
      originalTriangleCount: result.originalTriangleCount,
      requestedTargetTriangleCount: result.requestedTargetTriangleCount,
      optimizedTriangleCount: result.optimizedTriangleCount,
      requestedReductionPercent: result.requestedReductionPercent,
      achievedReductionPercent: result.achievedReductionPercent,
      originalBytes: result.originalBytes,
      optimizedBytes: result.optimizedBytes,
      actualBytesSaved: result.actualBytesSaved,
      actualSizeReductionPercent: result.actualSizeReductionPercent,
      attemptedCollapses: result.attemptedCollapses,
      acceptedCollapses: result.acceptedCollapses,
      rejectedCollapsesByReason: result.rejectedCollapsesByReason,
      shellCountBefore: result.shellCountBefore,
      shellCountAfter: result.shellCountAfter,
      boundaryEdgesBefore: result.boundaryEdgesBefore,
      boundaryEdgesAfter: result.boundaryEdgesAfter,
      nonManifoldEdgesBefore: result.nonManifoldEdgesBefore,
      nonManifoldEdgesAfter: result.nonManifoldEdgesAfter,
    },
    stopReason: result.stopReason,
    deviation: result.deviation,
    surfaceArea: {
      before: result.surfaceAreaBefore,
      after: result.surfaceAreaAfter,
      change: result.surfaceAreaChange,
      changePercent: result.surfaceAreaChangePercent,
    },
    volume: {
      before: result.volumeBefore,
      after: result.volumeAfter,
      change: result.volumeChange,
      changePercent: result.volumeChangePercent,
      status: result.volumeStatus,
      reason: result.volumeReason,
    },
    appliedThresholds: result.appliedThresholds,
    thresholdCheck: result.thresholdCheck,
    stageTimingsMs,
    warnings: result.warnings,
    unresolvedProblems: result.unresolvedProblems,
    limitations: LIMITATIONS,
  };
}
