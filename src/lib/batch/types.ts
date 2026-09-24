/**
 * The shared batch job model — one shape reused by every batch
 * operation (conversion, repair, optimization). Format-specific detail
 * (settings shape, result metadata shape) is generic here and owned by
 * each operation's own adapter (`adapter-registry.ts`), never
 * duplicated per operation.
 */
import type { SafeError } from "../errors";

export type BatchJobState = "queued" | "validating" | "processing" | "verifying" | "succeeded" | "failed" | "cancelled";

export const BATCH_JOB_STATES: readonly BatchJobState[] = ["queued", "validating", "processing", "verifying", "succeeded", "failed", "cancelled"];

export type BatchOperationId =
  | "convert-3mf-to-stl"
  | "convert-obj-to-stl"
  | "convert-glb-to-stl"
  | "convert-ply-to-stl"
  | "convert-stl-to-obj"
  | "convert-stl-to-3mf"
  | "repair-stl"
  | "optimize-stl";

export interface BatchJob<TSettings = unknown, TResultMeta = unknown> {
  /** Stable internal id — never derived from the filename, so two files named identically never collide. */
  readonly id: string;
  readonly file: File;
  /** Sanitized for display — never trusted as a real filesystem path (see `filenames.ts`). */
  displayName: string;
  readonly sourceSize: number;
  readonly operationId: BatchOperationId;
  settings: TSettings;
  state: BatchJobState;
  progressStage: string | null;
  /** 0..1 */
  progressValue: number;
  resultMeta: TResultMeta | null;
  outputBytes: ArrayBuffer | null;
  error: SafeError | null;
  readonly createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /**
   * Bumped every time this job is cancelled or retried. A worker
   * response tagged with an older generation than the job's current one
   * is stale and must be ignored — mirrors `WorkerClient`'s own
   * requestId-based staleness guard, one level up (per-job instead of
   * per-request).
   */
  cancellationGeneration: number;
  retryCount: number;
  /**
   * A strictly increasing tie-breaker for "how long has this job been
   * waiting to run" — bumped on initial creation AND on every retry, so
   * a retried job goes to the BACK of the FIFO line behind jobs that
   * were already queued, rather than jumping ahead just because it
   * happens to sit earlier in the job list. The scheduler orders its
   * dispatch queue by this field, never by array position or wall-clock
   * time (which isn't precise enough to break ties within one tick).
   */
  queuedSequence: number;
}

let jobSequence = 0;

function nextJobId(): string {
  jobSequence += 1;
  return `batch-job-${Date.now().toString(36)}-${jobSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

let queuedSequenceCounter = 0;

export function nextQueuedSequence(): number {
  queuedSequenceCounter += 1;
  return queuedSequenceCounter;
}

export interface CreateBatchJobInput<TSettings> {
  file: File;
  displayName: string;
  operationId: BatchOperationId;
  settings: TSettings;
}

export function createBatchJob<TSettings, TResultMeta = unknown>(input: CreateBatchJobInput<TSettings>): BatchJob<TSettings, TResultMeta> {
  return {
    id: nextJobId(),
    file: input.file,
    displayName: input.displayName,
    sourceSize: input.file.size,
    operationId: input.operationId,
    settings: input.settings,
    state: "queued",
    progressStage: null,
    progressValue: 0,
    resultMeta: null,
    outputBytes: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    cancellationGeneration: 0,
    retryCount: 0,
    queuedSequence: nextQueuedSequence(),
  };
}
