/**
 * The batch queue's own state machine — one `BatchQueue` instance per
 * batch session, holding every job in memory (never source/output bytes
 * in `localStorage` — see `presets.ts` for what IS persisted). Every
 * mutation goes through this module so the valid-transition graph and
 * the stale-report guard are enforced in exactly one place.
 *
 * Duplicate-identity policy (documented, deliberate): two files are the
 * "same" job only when their display name, byte size AND target
 * operation all match. A same-named file of a different size is a
 * genuinely different file (e.g. a re-exported/updated version) and is
 * allowed; the same file queued under a different operation is also
 * allowed, since batch conversion and batch repair of the same source
 * file are independent jobs.
 *
 * Stale-report policy: every job carries its own
 * `cancellationGeneration`, bumped on cancel and on retry. A worker
 * eventually reports progress/success/failure tagged with the
 * generation it was dispatched under — `reportProgress`/`reportSuccess`/
 * `reportFailure` silently ignore (return `false` from) any report
 * whose generation no longer matches the job's CURRENT generation. This
 * is the exact same pattern `WorkerClient` already uses per-request,
 * applied per-job here.
 */
import type { SafeError } from "../errors";
import { createBatchJob, nextQueuedSequence, type BatchJob, type BatchJobState, type BatchOperationId, type CreateBatchJobInput } from "./types";

const FORWARD_TRANSITIONS: Record<BatchJobState, readonly BatchJobState[]> = {
  queued: ["validating", "cancelled"],
  validating: ["processing", "failed", "cancelled"],
  processing: ["verifying", "succeeded", "failed", "cancelled"],
  verifying: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const ACTIVE_STATES: readonly BatchJobState[] = ["validating", "processing", "verifying"];
const TERMINAL_STATES: readonly BatchJobState[] = ["succeeded", "failed", "cancelled"];

function duplicateKey(displayName: string, size: number, operationId: BatchOperationId): string {
  return `${operationId}::${displayName.toLowerCase()}::${size}`;
}

export class BatchQueue {
  private jobs: BatchJob[] = [];
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  getJobs(): readonly BatchJob[] {
    return this.disposed ? [] : this.jobs;
  }

  getJob(id: string): BatchJob | undefined {
    if (this.disposed) return undefined;
    return this.jobs.find((j) => j.id === id);
  }

  /** Returns the created job, or `null` if rejected as a duplicate. */
  addFile<TSettings>(input: CreateBatchJobInput<TSettings>): BatchJob<TSettings> | null {
    if (this.disposed) return null;
    const key = duplicateKey(input.displayName, input.file.size, input.operationId);
    const isDuplicate = this.jobs.some((j) => duplicateKey(j.displayName, j.sourceSize, j.operationId) === key);
    if (isDuplicate) return null;

    const job = createBatchJob(input);
    this.jobs.push(job);
    this.notify();
    return job;
  }

  /** Only a job NOT currently active (queued, or a terminal state) may be removed — an active job must be cancelled first. */
  removeJob(id: string): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || ACTIVE_STATES.includes(job.state)) return false;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.notify();
    return true;
  }

  clearCompleted(): void {
    if (this.disposed) return;
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => !TERMINAL_STATES.includes(j.state));
    if (this.jobs.length !== before) this.notify();
  }

  /** The low-level state-machine primitive — only allows a move present in `FORWARD_TRANSITIONS`. Returns `false` (never throws) for an unknown job or an illegal move. */
  transition(id: string, next: BatchJobState): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job) return false;
    if (!FORWARD_TRANSITIONS[job.state].includes(next)) return false;
    job.state = next;
    if (next === "validating" && job.startedAt === null) job.startedAt = Date.now();
    if (TERMINAL_STATES.includes(next)) job.completedAt = Date.now();
    this.notify();
    return true;
  }

  /** Resets a failed/cancelled job back to `"queued"` for a fresh attempt, bumping its generation so any late report from the abandoned attempt is ignored. */
  retry(id: string): BatchJob | null {
    if (this.disposed) return null;
    const job = this.getJob(id);
    if (!job || (job.state !== "failed" && job.state !== "cancelled")) return null;
    job.state = "queued";
    job.error = null;
    job.progressStage = null;
    job.progressValue = 0;
    job.startedAt = null;
    job.completedAt = null;
    job.retryCount += 1;
    job.cancellationGeneration += 1;
    job.queuedSequence = nextQueuedSequence();
    this.notify();
    return job;
  }

  /** Cancels a job in any non-terminal state, bumping its generation so an in-flight worker report for it is ignored. */
  cancel(id: string): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || TERMINAL_STATES.includes(job.state)) return false;
    job.state = "cancelled";
    job.completedAt = Date.now();
    job.cancellationGeneration += 1;
    this.notify();
    return true;
  }

  cancelAll(): void {
    if (this.disposed) return;
    let changed = false;
    for (const job of this.jobs) {
      if (TERMINAL_STATES.includes(job.state)) continue;
      job.state = "cancelled";
      job.completedAt = Date.now();
      job.cancellationGeneration += 1;
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Only a still-`"queued"` job's underlying file may be replaced — once validation/processing has started, the job must be cancelled and re-added instead. */
  replaceJobFile(id: string, file: File, displayName: string): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || job.state !== "queued") return false;
    (job as { file: File }).file = file;
    (job as { sourceSize: number }).sourceSize = file.size;
    job.displayName = displayName;
    this.notify();
    return true;
  }

  reportProgress(id: string, generation: number, stage: string, value: number): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || job.cancellationGeneration !== generation) return false;
    job.progressStage = stage;
    job.progressValue = value;
    this.notify();
    return true;
  }

  reportSuccess<TResultMeta>(id: string, generation: number, resultMeta: TResultMeta, outputBytes: ArrayBuffer): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || job.cancellationGeneration !== generation) return false;
    job.resultMeta = resultMeta;
    job.outputBytes = outputBytes;
    job.state = "succeeded";
    job.completedAt = Date.now();
    this.notify();
    return true;
  }

  reportFailure(id: string, generation: number, error: SafeError): boolean {
    if (this.disposed) return false;
    const job = this.getJob(id);
    if (!job || job.cancellationGeneration !== generation) return false;
    job.error = error;
    job.state = "failed";
    job.completedAt = Date.now();
    this.notify();
    return true;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    // Invalidate every job's generation so any report still in flight is
    // recognized as stale even though the job itself is dropped below.
    for (const job of this.jobs) job.cancellationGeneration += 1;
    this.disposed = true;
    this.jobs = [];
    this.listeners.clear();
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
