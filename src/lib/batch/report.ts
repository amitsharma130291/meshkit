/**
 * Builds the downloadable, schema-versioned batch JSON summary — same
 * safety posture as every other report in this project
 * (`stl-repair/report.ts`, `gcode/report.ts`): a deliberate subset of
 * each job's own state. Never the job's raw output `ArrayBuffer`, the
 * source `File`'s real name/path (only `displayName`, already sanitized
 * by `filenames.ts` upstream), or an error's raw `message` (only its
 * stable `code` — the message text exists for on-screen display, never
 * for embedding in a downloadable artifact).
 */
import type { BatchJob, BatchJobState, BatchOperationId } from "./types";
import { CONVERSION_RESULT_META_ALLOWED_KEYS, isConversionOperationId } from "./conversion-result-meta";
import { sanitizeResultMetaForReport } from "./result-meta-guard";

export const BATCH_REPORT_SCHEMA_VERSION = "1.0.0";

export type ArchiveStatus = "not-generated" | "generated" | "failed" | "too-large";

export interface BatchReportFileEntry {
  safeFilename: string;
  sourceSize: number;
  outputSize: number | null;
  state: BatchJobState;
  resultMeta: unknown;
  errorCode: string | null;
  retryCount: number;
}

export interface DownloadableBatchReport {
  schemaVersion: string;
  generatedAt: string;
  operationId: BatchOperationId;
  settings: unknown;
  fileCountsByState: Record<BatchJobState, number>;
  files: BatchReportFileEntry[];
  archiveStatus: ArchiveStatus;
  limitations: string[];
}

const LIMITATIONS = [
  "Every file in a batch is processed independently — one file's failure never affects another file's already-succeeded result.",
  "This report never includes raw output bytes, source file paths, or exception detail — only stable outcome/error codes and the same safe display filename shown in the UI.",
  "An operation's own honest outcome policy (e.g. STL Repair's or STL Optimization's outcome states) is preserved verbatim here — a batch job is only reported \"succeeded\" when that operation's own verification actually produced usable output, never merely because processing finished without throwing.",
];

function emptyStateCounts(): Record<BatchJobState, number> {
  return { queued: 0, validating: 0, processing: 0, verifying: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

/**
 * Stage 4 defense-in-depth (Phase 10 hotfix) — applied to every job's
 * `resultMeta` right before it enters a downloadable report, regardless
 * of operation. For the six conversion operations (the ones the
 * confirmed defect actually affected) this also enforces the explicit
 * per-format key allowlist from `conversion-result-meta.ts`; repair and
 * optimize's own already-bounded `resultMeta` shapes only get the
 * structural check (binary/circular/depth/size), never a key allowlist,
 * per this hotfix's explicit instruction not to refactor their adapters.
 */
export function sanitizeJobResultMetaForReport(operationId: BatchOperationId, resultMeta: unknown): unknown {
  const allowedKeys = isConversionOperationId(operationId) ? CONVERSION_RESULT_META_ALLOWED_KEYS[operationId] : undefined;
  return sanitizeResultMetaForReport(resultMeta, { allowedKeys });
}

export function buildDownloadableBatchReport(
  jobs: readonly BatchJob[],
  operationId: BatchOperationId,
  settings: unknown,
  archiveStatus: ArchiveStatus,
): DownloadableBatchReport {
  const fileCountsByState = emptyStateCounts();
  const files: BatchReportFileEntry[] = [];

  for (const job of jobs) {
    fileCountsByState[job.state] += 1;
    files.push({
      safeFilename: job.displayName,
      sourceSize: job.sourceSize,
      outputSize: job.outputBytes ? job.outputBytes.byteLength : null,
      state: job.state,
      resultMeta: sanitizeJobResultMetaForReport(operationId, job.resultMeta),
      errorCode: job.error?.code ?? null,
      retryCount: job.retryCount,
    });
  }

  return {
    schemaVersion: BATCH_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    operationId,
    settings,
    fileCountsByState,
    files,
    archiveStatus,
    limitations: LIMITATIONS,
  };
}
