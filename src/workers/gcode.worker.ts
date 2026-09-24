/// <reference lib="webworker" />
/**
 * Parses and analyzes a G-code file entirely inside this worker,
 * powering all five G-code Cluster routes through one shared
 * orchestrator/client (`_client.ts`).
 *
 * This project's worker protocol (`WorkerRequest`) delivers a file as
 * one already-materialized `ArrayBuffer` — every existing tool in this
 * codebase reads a `File` into an `ArrayBuffer` on the main thread
 * first (see `FileSession.readArrayBuffer()`) and transfers it whole;
 * there is no File/Blob-over-postMessage mechanism to change that
 * without touching shared infrastructure every other tool depends on.
 * So the actual `File.slice()`-level incremental read isn't done here —
 * instead, THIS worker slices the already-received buffer into small,
 * bounded pieces and feeds them through `analyzeGCode()`'s own chunk
 * iterator, which uses `chunked-lines.ts`'s bounded streaming decoder.
 * That keeps the actual risk this requirement guards against — decoding
 * the WHOLE file into one giant string, or splitting it into one
 * unbounded array of line strings — from ever happening, even though
 * the raw bytes arrive as a single buffer per this project's own
 * standing file-intake convention.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { CancellationRequested } from "../lib/cancellation";
import { analyzeGCode, DEFAULT_ANALYZE_LIMITS } from "../lib/gcode/analyze";
import { toGCodeSafeError } from "../lib/gcode/errors";

declare const self: DedicatedWorkerGlobalScope;

const cancelledRequestIds = new Set<string>();

/** Bytes per slice fed into the bounded line decoder — small enough that no single decode step ever holds more than this much raw text in memory at once. */
const WORKER_CHUNK_BYTES = 256 * 1024;

function postProgress(requestId: string, stage: string): void {
  const response: WorkerResponse = { type: "progress", requestId, stage, completed: 0 };
  self.postMessage(response);
}

function postCancelled(requestId: string): void {
  cancelledRequestIds.delete(requestId);
  const response: WorkerResponse = { type: "cancelled", requestId };
  self.postMessage(response);
}

function* sliceBuffer(buffer: ArrayBuffer): Generator<Uint8Array> {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += WORKER_CHUNK_BYTES) {
    yield bytes.subarray(i, i + WORKER_CHUNK_BYTES);
  }
}

function collectTransferables(result: Awaited<ReturnType<typeof analyzeGCode>>): Transferable[] {
  const transfer: Transferable[] = [];
  for (const chunk of result.render.chunks) {
    transfer.push(
      chunk.positions.buffer,
      chunk.categoryCodes.buffer,
      chunk.featureCodes.buffer,
      chunk.toolIndices.buffer,
      chunk.feedRates.buffer,
      chunk.eDeltas.buffer,
      chunk.layerIndices.buffer,
      chunk.temperatures.buffer,
      chunk.cumulativeTimeSeconds.buffer,
    );
    if (chunk.sourceLineIndices) transfer.push(chunk.sourceLineIndices.buffer);
  }
  return transfer;
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const isCancelled = (): boolean => cancelledRequestIds.has(requestId);

  try {
    postProgress(requestId, "Reading file");

    const result = await analyzeGCode(sliceBuffer(buffer), DEFAULT_ANALYZE_LIMITS, {
      isCancelled,
      onProgress: (stage) => postProgress(requestId, stage),
    });

    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "Ready");

    const response: WorkerResponse = { type: "result", requestId, result };
    self.postMessage(response, collectTransferables(result));
  } catch (error) {
    if (error instanceof CancellationRequested) return postCancelled(requestId);
    const safe = toGCodeSafeError(error);
    const response: WorkerResponse = {
      type: "error",
      requestId,
      code: safe.code,
      message: safe.message,
      recoverable: safe.recoverable,
    };
    self.postMessage(response);
  }
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
