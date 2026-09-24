/**
 * Dispatches queued jobs from a `BatchQueue` through a `JobRunner`,
 * bounded by concurrency and (optionally) a `MemoryBudget`. Browser
 * processing is CPU- and memory-bound, so concurrency defaults to 1 and
 * is capped at 2 — never inferred from `navigator.hardwareConcurrency`,
 * which says nothing about how much memory is actually free.
 *
 * FIFO order is `queuedSequence`, not array position — a retried job
 * goes to the BACK of the line behind jobs that were already waiting
 * (see `types.ts`'s own doc comment on `queuedSequence`).
 *
 * A job whose estimated memory footprint doesn't currently fit the
 * budget is skipped (left queued) rather than blocking smaller jobs
 * behind it — the dispatch loop keeps scanning past it every time a
 * slot frees, so it's retried automatically once enough budget is
 * available, and nothing is starved forever by one heavy file.
 */
import type { BatchOperationId, BatchJob } from "./types";
import type { BatchQueue } from "./queue-state";
import type { MemoryBudget } from "./memory-budget";
import type { SafeError } from "../errors";

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 2;

export interface JobRunContext {
  isCancelled: () => boolean;
  onProgress: (stage: string, value: number) => void;
  enterState: (state: "processing" | "verifying") => void;
}

export type JobRunOutcome = { ok: true; resultMeta: unknown; outputBytes: ArrayBuffer } | { ok: false; error: SafeError };

export interface JobRunner {
  run(job: BatchJob, context: JobRunContext): Promise<JobRunOutcome>;
}

export interface SchedulerOptions {
  /** Clamped to [1, 2]. Defaults to 1. */
  concurrency?: number;
  memoryBudget?: MemoryBudget;
}

export class BatchScheduler {
  private concurrency: number;
  private readonly inFlight = new Map<string, number>(); // jobId -> generation captured at dispatch
  private paused = true;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  /** Guards against reentrant `pump()` calls — `dispatch()`'s own `queue.transition()` synchronously notifies this scheduler's subscription, which would otherwise re-enter `pump()` mid-loop and dispatch jobs out of FIFO order. */
  private isPumping = false;

  constructor(
    private readonly queue: BatchQueue,
    private readonly runner: JobRunner,
    private readonly options: SchedulerOptions = {},
  ) {
    this.concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, options.concurrency ?? MIN_CONCURRENCY));
  }

  start(): void {
    if (this.disposed) return;
    this.paused = false;
    if (!this.unsubscribe) this.unsubscribe = this.queue.subscribe(() => this.pump());
    this.pump();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    this.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paused = true;
    this.inFlight.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * The concurrency the user configured (always 1 or 2, clamped).
   */
  getConfiguredConcurrency(): number {
    return this.concurrency;
  }

  /**
   * How many job slots are actually running right now, bounded by the
   * configured concurrency. This can be LOWER than the configured value
   * — not just because fewer files are queued, but because a
   * `MemoryBudget` is refusing to schedule an otherwise-eligible queued
   * file until a slot's memory is released. The UI reports this
   * alongside the configured value so "2 configured, 1 running" reads
   * as a real, explainable state rather than a bug.
   */
  getEffectiveConcurrency(): number {
    return Math.min(this.activeJobCount(), this.concurrency);
  }

  /**
   * Changes the configured concurrency. Rejects (returns `false`, leaves
   * the prior value untouched) anything other than the integers 1 or 2
   * — never silently clamps a bad value, since a clamp could surprise a
   * caller who passed `0` or `NaN` by mistake.
   *
   * Documented rule for changing concurrency while jobs are already
   * running: lowering it never cancels or interrupts an in-flight job.
   * It only pauses NEW dispatches until the active count naturally drops
   * back below the new limit (see `pump()`'s own loop condition).
   * Raising it takes effect immediately — `pump()` is invoked so any
   * job already queued and eligible starts dispatching right away
   * without waiting for the next queue-state change.
   */
  setConcurrency(value: number): boolean {
    if (!Number.isInteger(value) || value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) return false;
    this.concurrency = value;
    this.pump();
    return true;
  }

  /**
   * Capacity is read from the QUEUE's own active-state count, never
   * from `inFlight.size` — a cancelled job leaves the active states the
   * instant `queue.cancel()` transitions it, freeing a slot immediately,
   * even though its underlying `runner.run()` promise may take a moment
   * longer to actually settle (that settlement is later recognized as
   * stale by generation and ignored — see `dispatch()`).
   */
  private activeJobCount(): number {
    return this.queue.getJobs().filter((j) => j.state === "validating" || j.state === "processing" || j.state === "verifying").length;
  }

  private pump(): void {
    if (this.disposed || this.paused || this.isPumping) return;
    this.isPumping = true;
    try {
      while (this.activeJobCount() < this.concurrency) {
        const next = this.pickNextQueuedJob();
        if (!next) return;
        this.dispatch(next);
      }
    } finally {
      this.isPumping = false;
    }
  }

  private pickNextQueuedJob(): BatchJob | null {
    const candidates = this.queue
      .getJobs()
      .filter((j) => j.state === "queued")
      .sort((a, b) => a.queuedSequence - b.queuedSequence);

    for (const job of candidates) {
      if (this.fits(job)) return job;
    }
    return null;
  }

  private fits(job: BatchJob): boolean {
    if (!this.options.memoryBudget) return true;
    return this.options.memoryBudget.canSchedule(job.id, job.operationId as BatchOperationId, job.sourceSize);
  }

  private dispatch(job: BatchJob): void {
    if (!this.queue.transition(job.id, "validating")) return;

    const generation = job.cancellationGeneration;
    this.inFlight.set(job.id, generation);
    this.options.memoryBudget?.reserve(job.id, job.operationId as BatchOperationId, job.sourceSize);

    const context: JobRunContext = {
      isCancelled: () => this.queue.getJob(job.id)?.cancellationGeneration !== generation,
      onProgress: (stage, value) => this.queue.reportProgress(job.id, generation, stage, value),
      enterState: (state) => this.queue.transition(job.id, state),
    };

    void this.runner.run(job, context).then((outcome) => {
      this.options.memoryBudget?.release(job.id);
      this.inFlight.delete(job.id);
      if (this.disposed) return;

      // `reportSuccess`/`reportFailure` already no-op for a stale
      // generation (job was cancelled/retried since dispatch) — no need
      // to duplicate that check here.
      if (outcome.ok) this.queue.reportSuccess(job.id, generation, outcome.resultMeta, outcome.outputBytes);
      else this.queue.reportFailure(job.id, generation, outcome.error);

      this.pump();
    });
  }
}
