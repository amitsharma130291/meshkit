import { describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "../workers/protocol";
import type { WorkerLike } from "../workers/worker-client";
import { createWorkerJobRunner } from "./worker-job-runner";
import { createBatchJob } from "./types";
import type { JobRunContext } from "./scheduler";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

function makeJob(settings: unknown = {}) {
  const file = new File([new Uint8Array(8)], "part.stl", { type: "model/stl" });
  return createBatchJob({ file, displayName: "part.stl", operationId: "repair-stl", settings });
}

function makeContext(overrides: Partial<JobRunContext> = {}): JobRunContext {
  return {
    isCancelled: () => false,
    onProgress: vi.fn(),
    enterState: vi.fn(),
    ...overrides,
  };
}

describe("createWorkerJobRunner — happy path", () => {
  it("initializes the worker, sends process once ready, and resolves ok on a matching result", async () => {
    let worker!: FakeWorker;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({ mode: "repair" }),
      verifyingStages: ["verifying-repaired-stl"],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(4) }),
    });

    const job = makeJob();
    const context = makeContext();
    const outcomePromise = runner.run(job, context);

    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();

    const processMsg = worker.sent.find((m) => m.type === "process");
    expect(processMsg).toBeTruthy();
    worker.emit({ type: "result", requestId: processMsg!.requestId, result: { outcome: "fully-repaired" } });

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.resultMeta).toEqual({ outcome: "fully-repaired" });
      expect(outcome.outputBytes.byteLength).toBe(4);
    }
    expect(worker.terminated).toBe(true);
  });

  it("relays progress stages and enters the verifying state on a configured stage", async () => {
    let worker!: FakeWorker;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: ["verifying-repaired-stl"],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(0) }),
    });
    const context = makeContext();
    const outcomePromise = runner.run(makeJob(), context);
    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();
    const processMsg = worker.sent.find((m) => m.type === "process")!;

    worker.emit({ type: "progress", requestId: processMsg.requestId, stage: "checking-original-mesh", completed: 0 });
    expect(context.enterState).not.toHaveBeenCalled();
    expect(context.onProgress).toHaveBeenCalledWith("checking-original-mesh", expect.any(Number));

    worker.emit({ type: "progress", requestId: processMsg.requestId, stage: "verifying-repaired-stl", completed: 0 });
    expect(context.enterState).toHaveBeenCalledWith("verifying");

    worker.emit({ type: "result", requestId: processMsg.requestId, result: {} });
    await outcomePromise;
  });
});

describe("createWorkerJobRunner — failure paths", () => {
  it("resolves not-ok on a worker error, and disposes the worker", async () => {
    let worker!: FakeWorker;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(0) }),
    });
    const outcomePromise = runner.run(makeJob(), makeContext());
    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();
    const processMsg = worker.sent.find((m) => m.type === "process")!;

    worker.emit({ type: "error", requestId: processMsg.requestId, code: "STL_TOO_COMPLEX", message: "too complex", recoverable: true });
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("resolves not-ok when unwrapResult rejects the result shape (no output geometry)", async () => {
    let worker!: FakeWorker;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: () => null,
    });
    const outcomePromise = runner.run(makeJob(), makeContext());
    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();
    const processMsg = worker.sent.find((m) => m.type === "process")!;
    worker.emit({ type: "result", requestId: processMsg.requestId, result: {} });
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
  });

  it("resolves not-ok when the worker itself fails to construct", async () => {
    const runner = createWorkerJobRunner({
      createWorker: () => {
        throw new Error("no worker support");
      },
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(0) }),
    });
    const outcome = await runner.run(makeJob(), makeContext());
    expect(outcome.ok).toBe(false);
  });
});

describe("createWorkerJobRunner — cancellation", () => {
  it("cancels the worker instead of sending process when already cancelled by the time the worker is ready", async () => {
    let worker!: FakeWorker;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(0) }),
    });
    const context = makeContext({ isCancelled: () => true });
    const outcomePromise = runner.run(makeJob(), context);
    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.sent.some((m) => m.type === "process")).toBe(false);
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("sends cancel to the worker when isCancelled flips true mid-progress", async () => {
    let worker!: FakeWorker;
    let cancelled = false;
    const runner = createWorkerJobRunner({
      createWorker: () => (worker = new FakeWorker()),
      formatLabel: "stl",
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: (raw) => ({ resultMeta: raw, outputBytes: new ArrayBuffer(0) }),
    });
    const context = makeContext({ isCancelled: () => cancelled });
    const outcomePromise = runner.run(makeJob(), context);
    await Promise.resolve();
    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    await Promise.resolve();
    await Promise.resolve();
    const processMsg = worker.sent.find((m) => m.type === "process")!;

    cancelled = true;
    worker.emit({ type: "progress", requestId: processMsg.requestId, stage: "some-stage", completed: 0 });
    expect(worker.sent.some((m) => m.type === "cancel")).toBe(true);

    worker.emit({ type: "cancelled", requestId: processMsg.requestId });
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
  });
});
