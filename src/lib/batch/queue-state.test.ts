import { describe, expect, it, vi } from "vitest";
import { BatchQueue } from "./queue-state";

function makeFile(name = "part.stl", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "model/stl" });
}

function addOne(queue: BatchQueue, name = "part.stl", size = 1024) {
  return queue.addFile({ file: makeFile(name, size), displayName: name, operationId: "repair-stl", settings: {} });
}

describe("BatchQueue — adding files", () => {
  it("adds a file as a new queued job", () => {
    const queue = new BatchQueue();
    const job = addOne(queue);
    expect(job).not.toBeNull();
    expect(job!.state).toBe("queued");
    expect(queue.getJobs()).toHaveLength(1);
  });

  it("preserves deterministic FIFO ordering across additions", () => {
    const queue = new BatchQueue();
    addOne(queue, "a.stl");
    addOne(queue, "b.stl");
    addOne(queue, "c.stl");
    expect(queue.getJobs().map((j) => j.displayName)).toEqual(["a.stl", "b.stl", "c.stl"]);
  });
});

describe("BatchQueue — duplicate rejection policy", () => {
  it("rejects a second file with the identical name, size AND operation (documented duplicate-identity policy)", () => {
    const queue = new BatchQueue();
    const first = addOne(queue, "part.stl", 1024);
    const second = addOne(queue, "part.stl", 1024);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(queue.getJobs()).toHaveLength(1);
  });

  it("allows a same-named file with a DIFFERENT size (genuinely different file)", () => {
    const queue = new BatchQueue();
    addOne(queue, "part.stl", 1024);
    const second = addOne(queue, "part.stl", 2048);
    expect(second).not.toBeNull();
    expect(queue.getJobs()).toHaveLength(2);
  });

  it("allows the identical file queued under a DIFFERENT operation", () => {
    const queue = new BatchQueue();
    const file = makeFile("part.stl", 1024);
    const a = queue.addFile({ file, displayName: "part.stl", operationId: "repair-stl", settings: {} });
    const b = queue.addFile({ file, displayName: "part.stl", operationId: "optimize-stl", settings: {} });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe("BatchQueue — removing queued files", () => {
  it("removes a queued job", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    expect(queue.removeJob(job.id)).toBe(true);
    expect(queue.getJobs()).toHaveLength(0);
  });

  it("refuses to remove a job that's actively processing", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    expect(queue.removeJob(job.id)).toBe(false);
    expect(queue.getJobs()).toHaveLength(1);
  });

  it("removing an unknown job id is a safe no-op returning false", () => {
    const queue = new BatchQueue();
    expect(queue.removeJob("does-not-exist")).toBe(false);
  });
});

describe("BatchQueue — clearing completed jobs", () => {
  it("removes succeeded, failed and cancelled jobs but keeps queued/active ones", () => {
    const queue = new BatchQueue();
    const succeeded = addOne(queue, "a.stl")!;
    const failedJob = addOne(queue, "b.stl")!;
    const cancelledJob = addOne(queue, "c.stl")!;
    const stillQueued = addOne(queue, "d.stl")!;

    queue.transition(succeeded.id, "validating");
    queue.transition(succeeded.id, "processing");
    queue.reportSuccess(succeeded.id, 0, {}, new ArrayBuffer(0));

    queue.transition(failedJob.id, "validating");
    queue.reportFailure(failedJob.id, 0, { code: "UNKNOWN_ERROR", message: "x", recoverable: false });

    queue.cancel(cancelledJob.id);

    queue.clearCompleted();

    const remaining = queue.getJobs().map((j) => j.id);
    expect(remaining).toEqual([stillQueued.id]);
  });
});

describe("BatchQueue — valid and invalid transitions", () => {
  it("allows the documented forward path queued -> validating -> processing -> verifying -> succeeded", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    expect(queue.transition(job.id, "validating")).toBe(true);
    expect(queue.transition(job.id, "processing")).toBe(true);
    expect(queue.transition(job.id, "verifying")).toBe(true);
    expect(queue.transition(job.id, "succeeded")).toBe(true);
    expect(queue.getJob(job.id)!.state).toBe("succeeded");
  });

  it("allows processing -> succeeded directly for operations with no separate verify stage", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    expect(queue.transition(job.id, "succeeded")).toBe(true);
  });

  it("rejects an illegal transition (e.g. queued straight to succeeded)", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    expect(queue.transition(job.id, "succeeded")).toBe(false);
    expect(queue.getJob(job.id)!.state).toBe("queued");
  });

  it("rejects a transition out of a terminal state", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    queue.transition(job.id, "succeeded");
    expect(queue.transition(job.id, "processing")).toBe(false);
    expect(queue.getJob(job.id)!.state).toBe("succeeded");
  });

  it("rejects a transition for an unknown job id", () => {
    const queue = new BatchQueue();
    expect(queue.transition("nope", "processing")).toBe(false);
  });
});

describe("BatchQueue — retrying failed jobs", () => {
  it("resets a failed job back to queued, clears its error, and increments retryCount", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.reportFailure(job.id, 0, { code: "UNKNOWN_ERROR", message: "x", recoverable: true });
    const retried = queue.retry(job.id);
    expect(retried).not.toBeNull();
    expect(retried!.state).toBe("queued");
    expect(retried!.error).toBeNull();
    expect(retried!.retryCount).toBe(1);
  });

  it("bumps the cancellation generation on retry, so a stale in-flight report from the PREVIOUS attempt is ignored", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    const staleGeneration = queue.getJob(job.id)!.cancellationGeneration;
    queue.reportFailure(job.id, staleGeneration, { code: "UNKNOWN_ERROR", message: "x", recoverable: true });
    queue.retry(job.id);
    // A late success report tagged with the OLD (pre-retry) generation must be ignored.
    const applied = queue.reportSuccess(job.id, staleGeneration, {}, new ArrayBuffer(0));
    expect(applied).toBe(false);
    expect(queue.getJob(job.id)!.state).toBe("queued");
  });

  it("refuses to retry a job that isn't failed or cancelled", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    expect(queue.retry(job.id)).toBeNull();
  });

  it("bumps queuedSequence past every already-queued job, so a retry goes to the BACK of the FIFO line", () => {
    const queue = new BatchQueue();
    const a = addOne(queue, "a.stl")!;
    const b = addOne(queue, "b.stl")!;
    queue.transition(a.id, "validating");
    queue.reportFailure(a.id, 0, { code: "UNKNOWN_ERROR", message: "x", recoverable: true });
    const retried = queue.retry(a.id)!;
    expect(retried.queuedSequence).toBeGreaterThan(queue.getJob(b.id)!.queuedSequence);
  });

  it("retrying a cancelled job also works", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.cancel(job.id);
    const retried = queue.retry(job.id);
    expect(retried!.state).toBe("queued");
  });
});

describe("BatchQueue — cancellation", () => {
  it("cancels a queued job", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.getJob(job.id)!.state).toBe("cancelled");
  });

  it("cancels a running (processing) job", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.getJob(job.id)!.state).toBe("cancelled");
  });

  it("cancelAll cancels every non-terminal job and leaves already-succeeded ones alone", () => {
    const queue = new BatchQueue();
    const a = addOne(queue, "a.stl")!;
    const b = addOne(queue, "b.stl")!;
    queue.transition(a.id, "validating");
    queue.transition(a.id, "processing");
    queue.transition(a.id, "verifying");
    queue.transition(a.id, "succeeded");
    queue.cancelAll();
    expect(queue.getJob(a.id)!.state).toBe("succeeded");
    expect(queue.getJob(b.id)!.state).toBe("cancelled");
  });

  it("cancelling a job bumps its generation, so a stale in-flight progress report is ignored afterward", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const staleGeneration = queue.getJob(job.id)!.cancellationGeneration;
    queue.cancel(job.id);
    const applied = queue.reportProgress(job.id, staleGeneration, "some-stage", 0.5);
    expect(applied).toBe(false);
    expect(queue.getJob(job.id)!.progressStage).toBeNull();
  });
});

describe("BatchQueue — a later job's failure never touches an earlier job's success", () => {
  it("preserves a succeeded job's result when a DIFFERENT job in the same queue fails", () => {
    const queue = new BatchQueue();
    const a = addOne(queue, "a.stl")!;
    const b = addOne(queue, "b.stl")!;
    queue.transition(a.id, "validating");
    queue.transition(a.id, "processing");
    queue.reportSuccess(a.id, 0, { ok: true }, new ArrayBuffer(4));

    queue.transition(b.id, "validating");
    queue.reportFailure(b.id, 0, { code: "UNKNOWN_ERROR", message: "x", recoverable: false });

    const stillA = queue.getJob(a.id)!;
    expect(stillA.state).toBe("succeeded");
    expect(stillA.resultMeta).toEqual({ ok: true });
    expect(stillA.outputBytes).not.toBeNull();
  });
});

describe("BatchQueue — replacing a queued job's underlying file", () => {
  it("replaces the file, size and display name of a still-queued job", () => {
    const queue = new BatchQueue();
    const job = addOne(queue, "old.stl", 1024)!;
    const newFile = makeFile("new.stl", 2048);
    const replaced = queue.replaceJobFile(job.id, newFile, "new.stl");
    expect(replaced).toBe(true);
    const updated = queue.getJob(job.id)!;
    expect(updated.displayName).toBe("new.stl");
    expect(updated.sourceSize).toBe(2048);
  });

  it("refuses to replace the file of a job that's already processing", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    expect(queue.replaceJobFile(job.id, makeFile("new.stl"), "new.stl")).toBe(false);
  });
});

describe("BatchQueue — stale progress/success/failure reports are ignored", () => {
  it("ignores a progress report tagged with an old generation", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const applied = queue.reportProgress(job.id, 999, "stage", 0.5);
    expect(applied).toBe(false);
  });

  it("ignores a success report tagged with an old generation", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const applied = queue.reportSuccess(job.id, 999, {}, new ArrayBuffer(0));
    expect(applied).toBe(false);
    expect(queue.getJob(job.id)!.state).toBe("processing");
  });

  it("ignores a failure report tagged with an old generation", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const applied = queue.reportFailure(job.id, 999, { code: "UNKNOWN_ERROR", message: "x", recoverable: false });
    expect(applied).toBe(false);
    expect(queue.getJob(job.id)!.state).toBe("processing");
  });

  it("accepts a report tagged with the CURRENT generation", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const current = queue.getJob(job.id)!.cancellationGeneration;
    expect(queue.reportProgress(job.id, current, "stage", 0.5)).toBe(true);
    expect(queue.getJob(job.id)!.progressStage).toBe("stage");
  });
});

describe("BatchQueue — disposal", () => {
  it("stops notifying subscribers after dispose", () => {
    const queue = new BatchQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.dispose();
    addOne(queue);
    expect(listener).not.toHaveBeenCalled();
  });

  it("a report for a job that existed before dispose is ignored after dispose (its generation is invalidated)", () => {
    const queue = new BatchQueue();
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.transition(job.id, "processing");
    const generation = queue.getJob(job.id)!.cancellationGeneration;
    queue.dispose();
    const applied = queue.reportSuccess(job.id, generation, {}, new ArrayBuffer(0));
    expect(applied).toBe(false);
  });

  it("getJobs() returns empty after dispose", () => {
    const queue = new BatchQueue();
    addOne(queue);
    queue.dispose();
    expect(queue.getJobs()).toEqual([]);
  });
});

describe("BatchQueue — subscribers are notified of changes", () => {
  it("notifies on add, transition, and removal", () => {
    const queue = new BatchQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    const job = addOne(queue)!;
    queue.transition(job.id, "validating");
    queue.cancel(job.id); // must reach a terminal state before it's removable
    queue.removeJob(job.id);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
