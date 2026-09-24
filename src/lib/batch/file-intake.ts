/**
 * Validates a fresh file selection (from `<input multiple>` or a drag-
 * and-drop) BEFORE any job is created — metadata only (`name`/`size`),
 * never `.arrayBuffer()`. Bytes are only ever read once a job is
 * actually scheduled to run (`worker-job-runner.ts`'s own
 * `job.file.arrayBuffer()` call, at dispatch time) — a rejected or
 * still-queued file's bytes are never touched.
 */
import { fileExtension } from "./adapter-types";
import type { BatchErrorCode } from "./errors";

export interface FileIntakeLimits {
  maxFileCount: number;
  maxIndividualBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_FILE_INTAKE_LIMITS: FileIntakeLimits = {
  maxFileCount: 200,
  maxIndividualBytes: 400 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface RejectedFile {
  file: File;
  reason: BatchErrorCode;
}

export interface FileIntakeResult {
  accepted: File[];
  rejected: RejectedFile[];
}

export interface ExistingQueueState {
  alreadyQueuedCount?: number;
  alreadyQueuedTotalBytes?: number;
}

function identityKey(file: File): string {
  return `${file.name.toLowerCase()}::${file.size}`;
}

export function validateIntake(
  files: readonly File[],
  acceptedExtensions: readonly string[],
  limits: FileIntakeLimits,
  existing: ExistingQueueState = {},
): FileIntakeResult {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  const seenInThisSelection = new Set<string>();

  let runningCount = existing.alreadyQueuedCount ?? 0;
  let runningBytes = existing.alreadyQueuedTotalBytes ?? 0;

  for (const file of files) {
    if (!acceptedExtensions.includes(fileExtension(file.name))) {
      rejected.push({ file, reason: "BATCH_UNSUPPORTED_FORMAT" });
      continue;
    }
    if (file.size > limits.maxIndividualBytes) {
      rejected.push({ file, reason: "BATCH_FILE_TOO_LARGE" });
      continue;
    }
    const key = identityKey(file);
    if (seenInThisSelection.has(key)) {
      rejected.push({ file, reason: "BATCH_DUPLICATE_FILE" });
      continue;
    }
    if (runningCount + 1 > limits.maxFileCount) {
      rejected.push({ file, reason: "BATCH_QUEUE_FULL" });
      continue;
    }
    if (runningBytes + file.size > limits.maxTotalBytes) {
      rejected.push({ file, reason: "BATCH_TOTAL_SIZE_EXCEEDED" });
      continue;
    }

    seenInThisSelection.add(key);
    runningCount += 1;
    runningBytes += file.size;
    accepted.push(file);
  }

  return { accepted, rejected };
}
