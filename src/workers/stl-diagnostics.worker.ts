/// <reference lib="webworker" />
/**
 * Parses and analyzes an STL file entirely inside this worker. Parsing
 * reuses `parseSTL()` unchanged (the exact same reader `stl-viewer.worker.ts`
 * uses) — this worker adds no second STL reader. Analysis is the full
 * `src/lib/stl-diagnostics/analyze.ts` pipeline over the parsed geometry.
 *
 * Progress stages mirror the pipeline's own real boundaries: `reading`
 * (parseSTL) is this worker's own stage, and every stage after that is
 * relayed straight from `analyzeSTLDiagnostics()`'s own `onProgress`
 * callback — never a second, hand-invented set of stage names that could
 * drift from what the analysis actually does.
 *
 * Cancellation follows the exact `stl-to-obj.worker.ts` precedent: an
 * `isCancelled()` closure checked after each stage, threaded into
 * `analyzeSTLDiagnostics()`'s own cancellation option for its two
 * mid-loop-cancellable stages (vertex dedup, self-intersection testing),
 * plus a `CancellationRequested` catch in the outer handler as a
 * defense-in-depth backstop for wherever that exception actually
 * surfaces from.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { DEFAULT_STL_LIMITS } from "../lib/stl/types";
import { CancellationRequested } from "../lib/cancellation";
import { analyzeSTLDiagnostics } from "../lib/stl-diagnostics/analyze";
import { toSTLDiagnosticsSafeError } from "../lib/stl-diagnostics/errors";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../lib/stl-diagnostics/types";
import type { STLDiagnosticsWorkerResult } from "../lib/stl-diagnostics/types";

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
  const isCancelled = (): boolean => cancelledRequestIds.has(requestId);

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    const stl = parseSTL(buffer, DEFAULT_STL_LIMITS);
    if (isCancelled()) return postCancelled(requestId);

    const report = await analyzeSTLDiagnostics(stl.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS, {
      isCancelled,
      onProgress: (stage) => postProgress(requestId, stage),
    });
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const result: STLDiagnosticsWorkerResult = { stl, report };
    const transfer: Transferable[] = [
      result.stl.positions.buffer,
      result.stl.normals.buffer,
      result.report.overlays.boundaryEdgeLines.buffer,
      result.report.overlays.nonManifoldEdgeLines.buffer,
      result.report.overlays.windingConflictEdgeLines.buffer,
      result.report.overlays.degenerateTrianglePositions.buffer,
      result.report.overlays.duplicateFacePositions.buffer,
      result.report.overlays.selfIntersectingTrianglePositions.buffer,
    ];
    for (const shellPositions of Object.values(result.report.overlays.shellPositionsById)) {
      transfer.push(shellPositions.buffer);
    }

    const response: WorkerResponse = { type: "result", requestId, result };
    self.postMessage(response, transfer);
  } catch (error) {
    if (error instanceof CancellationRequested) return postCancelled(requestId);
    const safe = toSTLDiagnosticsSafeError(error);
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
