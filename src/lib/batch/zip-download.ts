/**
 * Packages a batch's results into one ZIP — `outputs/` (succeeded jobs
 * only), `reports/` (every job, succeeded or not), and a top-level
 * `batch-summary.json`. Uses `fflate` directly through this
 * general-purpose module, never `threemf/package-writer.ts` (that one
 * writes the specific fixed 3-entry OPC layout a 3MF reader requires —
 * unrelated to a general batch archive).
 *
 * A failed or cancelled job always gets its report entry, so the ZIP
 * fully accounts for the batch, but never a fake `outputs/` file — an
 * empty or synthetic "output" for a job that didn't actually produce
 * one would misrepresent what happened.
 */
import { strToU8, zipSync } from "fflate";
import { batchError } from "./errors";
import { FilenameCollisionTracker } from "./filenames";
import type { BatchJobState } from "./types";

export interface ZipDownloadLimits {
  maxFileCount: number;
  maxUncompressedBytes: number;
  maxIndividualOutputBytes: number;
  maxFilenameLength: number;
  maxReportBytes: number;
}

export const DEFAULT_ZIP_DOWNLOAD_LIMITS: ZipDownloadLimits = {
  maxFileCount: 500,
  maxUncompressedBytes: 300 * 1024 * 1024,
  maxIndividualOutputBytes: 100 * 1024 * 1024,
  maxFilenameLength: 200,
  maxReportBytes: 5 * 1024 * 1024,
};

export interface ZipJobEntry {
  jobId: string;
  /** Already sanitized/collision-resolved by `filenames.ts` at job-completion time — resolved AGAIN defensively here against every other entry in this ZIP specifically. */
  outputFilename: string;
  /** `null` for a job that never produced output (failed/cancelled) — never a placeholder buffer. */
  outputBytes: ArrayBuffer | null;
  reportJson: string;
  state: BatchJobState;
}

/** Same fixed timestamp `package-writer.ts` uses, for the same reason: identical batch content should produce byte-identical archive output. */
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z");

export function buildBatchZip(entries: readonly ZipJobEntry[], summaryJson: string, limits: ZipDownloadLimits = DEFAULT_ZIP_DOWNLOAD_LIMITS): ArrayBuffer {
  if (entries.length > limits.maxFileCount) throw batchError("BATCH_ZIP_TOO_LARGE");
  if (strToU8(summaryJson).byteLength > limits.maxReportBytes) throw batchError("BATCH_ZIP_TOO_LARGE");

  const zipInput: Record<string, Uint8Array> = { "batch-summary.json": strToU8(summaryJson) };
  const outputNames = new FilenameCollisionTracker();
  const reportNames = new FilenameCollisionTracker();
  let totalBytes = strToU8(summaryJson).byteLength;

  for (const item of entries) {
    if (item.outputFilename.length > limits.maxFilenameLength) throw batchError("BATCH_ZIP_TOO_LARGE");

    if (item.outputBytes) {
      if (item.outputBytes.byteLength > limits.maxIndividualOutputBytes) throw batchError("BATCH_ZIP_TOO_LARGE");
      const name = outputNames.reserve(item.outputFilename);
      zipInput[`outputs/${name}`] = new Uint8Array(item.outputBytes);
      totalBytes += item.outputBytes.byteLength;
    }

    const reportBytes = strToU8(item.reportJson);
    if (reportBytes.byteLength > limits.maxReportBytes) throw batchError("BATCH_ZIP_TOO_LARGE");
    const reportName = reportNames.reserve(`${item.outputFilename}.json`);
    zipInput[`reports/${reportName}`] = reportBytes;
    totalBytes += reportBytes.byteLength;
  }

  if (totalBytes > limits.maxUncompressedBytes) throw batchError("BATCH_ZIP_TOO_LARGE");

  let zipped: Uint8Array;
  try {
    zipped = zipSync(zipInput, { mtime: FIXED_MTIME, level: 6 });
  } catch {
    throw batchError("BATCH_ZIP_GENERATION_FAILED");
  }

  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}
