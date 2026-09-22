/// <reference lib="webworker" />
/**
 * Parses an STL file entirely inside this worker — geometry never touches
 * the main thread until the finished typed arrays are transferred back.
 * Uses the Phase 1 worker protocol (src/lib/workers/protocol.ts) exactly
 * as foundation.worker.ts does.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { toSTLSafeError } from "../lib/stl/errors";
import { DEFAULT_STL_LIMITS } from "../lib/stl/types";

declare const self: DedicatedWorkerGlobalScope;

const cancelledRequestIds = new Set<string>();

function postProgress(requestId: string, stage: string): void {
  const response: WorkerResponse = { type: "progress", requestId, stage, completed: 0 };
  self.postMessage(response);
}

function postCancelled(requestId: string): void {
  cancelledRequestIds.delete(requestId);
  const response: WorkerResponse = { type: "cancelled", requestId };
  self.postMessage(response);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "detecting-format");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing");
    const parsed = parseSTL(buffer, DEFAULT_STL_LIMITS);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "calculating-bounds");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "preparing-model");

    const result = {
      encoding: parsed.encoding,
      triangleCount: parsed.triangleCount,
      positions: parsed.positions,
      normals: parsed.normals,
      bounds: parsed.bounds,
      header: parsed.header,
    };

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    // Transfer the underlying buffers — the worker never touches them again.
    self.postMessage(response, [result.positions.buffer, result.normals.buffer]);
  } catch (error) {
    const safe = toSTLSafeError(error);
    const response: WorkerResponse = {
      type: "error",
      requestId,
      code: safe.code,
      message: safe.message,
      recoverable: safe.recoverable,
    };
    self.postMessage(response);
  }
  // `buffer` (the original file bytes) is only ever referenced by this
  // function's local scope — once it returns, nothing in the worker still
  // holds it, so it becomes eligible for garbage collection immediately.
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "initialize": {
      const response: WorkerResponse = { type: "ready", requestId: message.requestId };
      self.postMessage(response);
      break;
    }
    case "process": {
      void handleProcess(message);
      break;
    }
    case "cancel": {
      cancelledRequestIds.add(message.requestId);
      break;
    }
    case "dispose": {
      cancelledRequestIds.clear();
      break;
    }
  }
};
