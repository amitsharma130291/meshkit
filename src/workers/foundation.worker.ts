/// <reference lib="webworker" />
/**
 * Proves the worker protocol end-to-end: it can be initialized, receive a
 * transferred file buffer, report progress, honor cancellation, and return
 * a typed result. It deliberately computes only safe, non-product
 * metadata (byte length and a lightweight checksum) — it must never be
 * mistaken for a real 3D file parser.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";

declare const self: DedicatedWorkerGlobalScope;

const cancelledRequestIds = new Set<string>();

function fnv1aChecksum(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const progress: WorkerResponse = {
    type: "progress",
    requestId: message.requestId,
    stage: "reading",
    completed: 0,
    total: message.buffer.byteLength,
  };
  self.postMessage(progress);

  // Yield one tick so a "cancel" sent immediately after "process" has a
  // chance to be observed before the (fast, synchronous) checksum runs.
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (cancelledRequestIds.has(message.requestId)) {
    cancelledRequestIds.delete(message.requestId);
    const cancelled: WorkerResponse = { type: "cancelled", requestId: message.requestId };
    self.postMessage(cancelled);
    return;
  }

  const result: WorkerResponse = {
    type: "result",
    requestId: message.requestId,
    result: {
      fileName: message.fileName,
      byteLength: message.buffer.byteLength,
      foundationChecksum: fnv1aChecksum(message.buffer),
    },
  };
  self.postMessage(result);
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
      handleProcess(message).catch(() => {
        const response: WorkerResponse = {
          type: "error",
          requestId: message.requestId,
          code: "UNKNOWN_ERROR",
          message: "The foundation worker failed unexpectedly.",
          recoverable: true,
        };
        self.postMessage(response);
      });
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
