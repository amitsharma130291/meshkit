/**
 * Builds the downloadable JSON repair report. Same safety posture as
 * `stl-diagnostics/report.ts`: a deliberate SUBSET of `RepairResult` —
 * never the `overlays` (binary geometry buffers), never `outputBytes`,
 * never raw triangle coordinates, the original file's own header text,
 * a stack trace, or a local path. The output STL is downloaded as its
 * own separate `.stl` file; this report is the human/machine-readable
 * companion, not a container for the geometry itself.
 */
import type { RepairLimits, RepairResult } from "./types";

export const STL_REPAIR_REPORT_SCHEMA_VERSION = "1.0.0";
export const STL_REPAIR_TOOL_VERSION = "1.0.0";

export interface DownloadableRepairReport {
  schemaVersion: string;
  toolVersion: string;
  generatedAt: string;
  file: { name: string; sizeBytes: number };
  settings: RepairResult["plan"]["settings"];
  limits: RepairLimits;
  outcome: RepairResult["outcome"];
  before: RepairResult["before"];
  after: RepairResult["after"];
  attemptedOperations: string[];
  successfulOperations: string[];
  skippedOperations: RepairResult["skippedOperations"];
  unresolvedProblems: string[];
  holeFillSkips: RepairResult["holeFillSkips"];
  counts: {
    verticesBefore: number;
    verticesAfter: number;
    trianglesBefore: number;
    trianglesAfter: number;
    verticesWelded: number;
    trianglesRemovedByCategory: RepairResult["trianglesRemovedByCategory"];
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
  };
  selfIntersections: { statusBefore: string; statusAfter: string | null };
  watertightVerdict: { before: string; after: string | null };
  stageTimingsMs: Record<string, number>;
  warnings: RepairResult["warnings"];
  limitations: string[];
}

const LIMITATIONS = [
  "This tool only repairs mesh topology — it never guarantees printability, wall thickness, physical scale, or fitness for any particular printer.",
  "Vertex welding, when enabled, uses exact float32 identity plus an explicit absolute tolerance in model units — never a percentage, and never changed silently between preview and export.",
  "Self-intersection resolution is detect-only in this phase — a self-intersection found before repair may still be present after repair, and is never claimed to be fixed.",
  "Non-manifold edges with more than two incident triangles are only resolved when the cause is a duplicate or degenerate triangle already removed elsewhere in this pipeline — arbitrary non-manifold topology is preserved and reported, never forced closed by deleting geometry.",
  "\"Fully repaired\" is only ever reported when the ACTUAL repaired output file was re-parsed and re-diagnosed clean — never assumed from the repair operations alone.",
];

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

export function buildDownloadableRepairReport(result: RepairResult, limits: RepairLimits, fileName: string, fileSizeBytes: number): DownloadableRepairReport {
  const stageTimingsMs: Record<string, number> = {};
  for (const s of result.stageTimings) stageTimingsMs[s.stage] = s.durationMs;

  return {
    schemaVersion: STL_REPAIR_REPORT_SCHEMA_VERSION,
    toolVersion: STL_REPAIR_TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    file: { name: sanitizeFileName(fileName), sizeBytes: fileSizeBytes },
    settings: result.plan.settings,
    limits,
    outcome: result.outcome,
    before: result.before,
    after: result.after,
    attemptedOperations: result.attemptedOperations,
    successfulOperations: result.successfulOperations,
    skippedOperations: result.skippedOperations,
    unresolvedProblems: result.unresolvedProblems,
    holeFillSkips: result.holeFillSkips,
    counts: {
      verticesBefore: result.verticesBefore,
      verticesAfter: result.verticesAfter,
      trianglesBefore: result.trianglesBefore,
      trianglesAfter: result.trianglesAfter,
      verticesWelded: result.verticesWelded,
      trianglesRemovedByCategory: result.trianglesRemovedByCategory,
      trianglesFlipped: result.trianglesFlipped,
      shellsReversed: result.shellsReversed,
      holesFilled: result.holesFilled,
      trianglesAdded: result.trianglesAdded,
      shellsRemoved: result.shellsRemoved,
      nonManifoldEdgesBefore: result.nonManifoldEdgesBefore,
      nonManifoldEdgesAfter: result.nonManifoldEdgesAfter,
      boundaryEdgesBefore: result.boundaryEdgesBefore,
      boundaryEdgesAfter: result.boundaryEdgesAfter,
      windingConflictsBefore: result.windingConflictsBefore,
      windingConflictsAfter: result.windingConflictsAfter,
    },
    selfIntersections: { statusBefore: result.selfIntersectionStatusBefore, statusAfter: result.selfIntersectionStatusAfter },
    watertightVerdict: { before: result.watertightVerdictBefore, after: result.watertightVerdictAfter },
    stageTimingsMs,
    warnings: result.warnings,
    limitations: LIMITATIONS,
  };
}
