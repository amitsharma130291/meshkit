import { describe, expect, it } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { WorkerClient, type WorkerClientEvents, type WorkerLike } from "./worker-client";

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

  /** Test helper: simulate a message arriving from the worker thread. */
  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

function readyWorker(events: WorkerClientEvents = {}): { client: WorkerClient; worker: FakeWorker } {
  let worker!: FakeWorker;
  const client = new WorkerClient(() => (worker = new FakeWorker()), events);
  client.initialize();
  worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
  return { client, worker };
}

describe("WorkerClient", () => {
  it("ignores a result for a process request superseded by a newer one", () => {
    const results: unknown[] = [];
    const events: WorkerClientEvents = { onResult: (result) => results.push(result) };
    const { client, worker } = readyWorker(events);

    const firstId = client.process("a.stl", "stl", new ArrayBuffer(4));
    const secondId = client.process("b.stl", "stl", new ArrayBuffer(4));

    worker.emit({ type: "result", requestId: firstId, result: { byteLength: 4 } });
    worker.emit({ type: "result", requestId: secondId, result: { byteLength: 8 } });

    expect(results).toEqual([{ byteLength: 8 }]);
  });

  it("ignores a ready response whose requestId does not match the current initialize handshake", () => {
    let readyCount = 0;
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker, { onReady: () => readyCount++ });
    client.initialize();

    worker.emit({ type: "ready", requestId: "stale-id" });
    expect(readyCount).toBe(0);

    worker.emit({ type: "ready", requestId: worker.sent[0]!.requestId });
    expect(readyCount).toBe(1);
  });

  it("delivers progress and error events only for the active request", () => {
    const progressEvents: number[] = [];
    const errors: string[] = [];
    const { client, worker } = readyWorker({
      onProgress: (_stage, completed) => progressEvents.push(completed),
      onError: (error) => errors.push(error.code),
    });

    const requestId = client.process("a.stl", "stl", new ArrayBuffer(4));
    worker.emit({ type: "progress", requestId, stage: "reading", completed: 1, total: 2 });
    worker.emit({ type: "progress", requestId: "stale", stage: "reading", completed: 99, total: 100 });
    worker.emit({ type: "error", requestId, code: "UNKNOWN_ERROR", message: "boom", recoverable: false });

    expect(progressEvents).toEqual([1]);
    expect(errors).toEqual(["UNKNOWN_ERROR"]);
  });

  it("transfers the buffer and terminates the worker on dispose", () => {
    const { client, worker } = readyWorker();
    const buffer = new ArrayBuffer(4);
    client.process("a.stl", "stl", buffer);

    client.dispose();
    expect(worker.terminated).toBe(true);
  });
});
