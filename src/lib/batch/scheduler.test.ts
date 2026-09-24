import { describe, expect, it, vi } from "vitest";
import { BatchQueue } from "./queue-state";
import { BatchScheduler, type JobRunContext, type JobRunOutcome, type JobRunner } from "./scheduler";
import { MemoryBudget } from "./memory-budget";

function makeFile(name = "part.stl", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "model/stl" });
}

function addOne(queue: BatchQueue, name = "part.stl", size = 1024) {
  return queue.addFile({ file: makeFile(name, size), displayName: name, operationId: "repair-stl", settings: {} })!;
}

/** Lets the scheduler's `runner.run(...).then(...)` microtask (and its own follow-up `pump()`) actually run before the next assertion. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A JobRunner whose promise resolution is fully controlled by the test, one resolver per dispatched job. */
class ControllableRunner implements JobRunner {
  readonly dispatched: string[] = [];
  readonly contexts = new Map<string, JobRunContext>();
  private resolvers = new Map<string, (outcome: JobRunOutcome) => void>();

  run(job: Parameters<JobRunner["run"]>[0], context: JobRunContext): Promise<JobRunOutcome> {
    this.dispatched.push(job.id);
    this.contexts.set(job.id, context);
    return new Promise<JobRunOutcome>((resolve) => this.resolvers.set(job.id, resolve));
  }

  succeed(jobId: string, outputBytes = new ArrayBuffer(4)): void {
    this.resolvers.get(jobId)?.({ ok: true, resultMeta: {}, outputBytes });
  }

  fail(jobId: string): void {
    this.resolvers.get(jobId)?.({ ok: false, error: { code: "UNKNOWN_ERROR", message: "x", recoverable: true } });
  }
}

describe("BatchScheduler — sequential default execution", () => {
  it("runs one job at a time when concurrency is left at its default of 1", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id]);
    expect(queue.getJob(b.id)!.state).toBe("queued");
    runner.succeed(a.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — maximum concurrency", () => {
  it("runs up to 2 jobs at once when concurrency is explicitly set to 2", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const c = addOne(queue, "c.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 2 });
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id, b.id]);
    expect(queue.getJob(c.id)!.state).toBe("queued");
    scheduler.dispose();
  });

  it("never exceeds a concurrency of 2 even if a caller asks for more", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    addOne(queue, "a.stl");
    addOne(queue, "b.stl");
    addOne(queue, "c.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 5 as never });
    scheduler.start();
    expect(runner.dispatched.length).toBeLessThanOrEqual(2);
    scheduler.dispose();
  });
});

describe("BatchScheduler — FIFO scheduling", () => {
  it("dispatches queued jobs in the order they were added", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const c = addOne(queue, "c.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    runner.succeed(a.id);
    await flush();
    runner.succeed(b.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id, b.id, c.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — cancellation and failure each free a slot", () => {
  it("cancelling the running job lets the next queued job start", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id]);
    queue.cancel(a.id); // cancel() is synchronous — no microtask flush needed
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });

  it("a failed job frees its slot for the next queued job", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    runner.fail(a.id);
    await flush();
    expect(queue.getJob(a.id)!.state).toBe("failed");
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — retry placement", () => {
  it("a retried job re-enters the FIFO queue behind jobs already queued", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    runner.fail(a.id);
    await flush();
    queue.retry(a.id);
    // b was already queued before a's retry — FIFO means b still goes first.
    runner.succeed(b.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id, b.id, a.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — pause/resume", () => {
  it("pause() stops starting new jobs; resume() continues", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    scheduler.pause();
    runner.succeed(a.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id]); // b not started while paused
    scheduler.resume();
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — total memory budget", () => {
  it("skips a job that doesn't currently fit the memory budget, without starving smaller jobs behind it", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const big = addOne(queue, "big.stl", 5_000_000);
    const small = addOne(queue, "small.stl", 10);
    const memoryBudget = new MemoryBudget({ maxTotalBytes: 1_000_000 }); // big alone can never fit
    const scheduler = new BatchScheduler(queue, runner, { memoryBudget });
    scheduler.start();
    expect(runner.dispatched).toEqual([small.id]);
    expect(queue.getJob(big.id)!.state).toBe("queued");
    scheduler.dispose();
  });

  it("frees budget when a job completes, allowing a previously-skipped job to start", async () => {
    // repair-stl's multiplier means each 400KB job reserves ~2.4MB (input + 5x expansion) —
    // budget fits exactly one at a time, not two concurrently.
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl", 400_000);
    const b = addOne(queue, "b.stl", 400_000);
    const memoryBudget = new MemoryBudget({ maxTotalBytes: 3_000_000 });
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 2, memoryBudget });
    scheduler.start();
    // both together would exceed budget at repair-stl's multiplier, so only one starts
    expect(runner.dispatched).toEqual([a.id]);
    runner.succeed(a.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });
});

describe("BatchScheduler — output-memory accounting", () => {
  it("releases a job's active memory reservation once it completes", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl", 100_000);
    const memoryBudget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    const reserveSpy = vi.spyOn(memoryBudget, "reserve");
    const releaseSpy = vi.spyOn(memoryBudget, "release");
    const scheduler = new BatchScheduler(queue, runner, { memoryBudget });
    scheduler.start();
    expect(reserveSpy).toHaveBeenCalledWith(a.id, "repair-stl", 100_000);
    runner.succeed(a.id);
    await flush();
    expect(releaseSpy).toHaveBeenCalledWith(a.id);
    scheduler.dispose();
  });
});

describe("BatchScheduler — disposal", () => {
  it("dispose() stops dispatching further jobs", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    scheduler.dispose();
    runner.succeed(a.id);
    await flush();
    expect(runner.dispatched).toEqual([a.id]);
  });

  it("a stale outcome resolving after dispose never mutates the queue", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const scheduler = new BatchScheduler(queue, runner);
    scheduler.start();
    scheduler.dispose();
    runner.succeed(a.id);
    await flush();
    // Queue itself wasn't disposed, only the scheduler was — job should remain untouched (still whatever state it was left in), never force-succeeded by a post-dispose resolution.
    expect(queue.getJob(a.id)?.state === "succeeded").toBe(false);
  });
});

describe("BatchScheduler — runtime concurrency control", () => {
  it("defaults getConfiguredConcurrency() to 1 when no option is passed", () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, new ControllableRunner());
    expect(scheduler.getConfiguredConcurrency()).toBe(1);
    scheduler.dispose();
  });

  it("rejects non-integer, zero, negative and NaN values, leaving the prior setting untouched", () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, new ControllableRunner(), { concurrency: 1 });
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(scheduler.setConcurrency(bad)).toBe(false);
      expect(scheduler.getConfiguredConcurrency()).toBe(1);
    }
    scheduler.dispose();
  });

  it("rejects any value above the hard cap of 2", () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, new ControllableRunner(), { concurrency: 1 });
    expect(scheduler.setConcurrency(3)).toBe(false);
    expect(scheduler.setConcurrency(100)).toBe(false);
    expect(scheduler.getConfiguredConcurrency()).toBe(1);
    scheduler.dispose();
  });

  it("accepts switching from 1 to 2 while idle, and it takes effect on the next dispatch", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 1 });
    expect(scheduler.setConcurrency(2)).toBe(true);
    expect(scheduler.getConfiguredConcurrency()).toBe(2);
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });

  it("raising concurrency while active immediately dispatches an already-queued eligible job", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 1 });
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id]);
    expect(scheduler.setConcurrency(2)).toBe(true);
    // setConcurrency() itself calls pump() — no queue event needed to pick up job b.
    expect(runner.dispatched).toEqual([a.id, b.id]);
    scheduler.dispose();
  });

  it("lowering concurrency while active never cancels running jobs — it only withholds new dispatches until the active count drops below the new limit", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    const b = addOne(queue, "b.stl");
    const c = addOne(queue, "c.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 2 });
    scheduler.start();
    expect(runner.dispatched).toEqual([a.id, b.id]);

    expect(scheduler.setConcurrency(1)).toBe(true);
    // Both a and b keep running — lowering concurrency is not cancellation.
    expect(queue.getJob(a.id)!.state).not.toBe("cancelled");
    expect(queue.getJob(b.id)!.state).not.toBe("cancelled");
    // c must not start: active count (2) is not below the new limit (1) yet.
    expect(runner.dispatched).toEqual([a.id, b.id]);

    runner.succeed(a.id);
    await flush();
    // Still at the new limit of 1 (b still running) — c stays queued.
    expect(runner.dispatched).toEqual([a.id, b.id]);
    expect(queue.getJob(c.id)!.state).toBe("queued");

    runner.succeed(b.id);
    await flush();
    // Now below the limit — c is finally dispatched.
    expect(runner.dispatched).toEqual([a.id, b.id, c.id]);
    scheduler.dispose();
  });

  it("getEffectiveConcurrency() reflects how many jobs are actually running, not just the configured cap", async () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    const a = addOne(queue, "a.stl");
    addOne(queue, "b.stl");
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 2 });
    scheduler.start();
    expect(scheduler.getConfiguredConcurrency()).toBe(2);
    expect(scheduler.getEffectiveConcurrency()).toBe(2);

    runner.succeed(a.id);
    await flush();
    // b keeps running, no third file queued — effective concurrency drops to 1 even though 2 is still configured.
    expect(scheduler.getEffectiveConcurrency()).toBe(1);
    scheduler.dispose();
  });

  it("a memory budget too small for a second file reduces effective concurrency below the configured cap", () => {
    const queue = new BatchQueue();
    const runner = new ControllableRunner();
    // Each file is 1000 bytes; repair-stl's multiplier is 5x, so one file alone reserves 6000 bytes (input + expansion).
    addOne(queue, "a.stl", 1000);
    addOne(queue, "b.stl", 1000);
    const memoryBudget = new MemoryBudget({ maxTotalBytes: 6500 }); // room for exactly one file's footprint, not two
    const scheduler = new BatchScheduler(queue, runner, { concurrency: 2, memoryBudget });
    scheduler.start();
    expect(scheduler.getConfiguredConcurrency()).toBe(2);
    expect(scheduler.getEffectiveConcurrency()).toBe(1);
    expect(runner.dispatched.length).toBe(1);
    scheduler.dispose();
  });
});
