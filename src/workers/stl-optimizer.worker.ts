/// <reference lib="webworker" />
/**
 * Parses, diagnoses, plans and optimizes an STL file entirely inside
 * this worker — same two-mode shape as `stl-repair.worker.ts`:
 *
 * - `options.mode === "plan"`: parse + diagnose + classify eligibility +
 *   preview the resolved target ONLY — mutates nothing. Powers "show the
 *   plan" before the user ever clicks "run optimization."
 * - `options.mode === "optimize"` (default): the full pipeline.
 *
 * Progress stages relay straight from `optimizeSTL()`'s own `onProgress`
 * callback (plus this worker's own `reading` stage before parsing) —
 * never a second, hand-invented stage list.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { DEFAULT_STL_LIMITS } from "../lib/stl/types";
import { CancellationRequested } from "../lib/cancellation";
import { analyzeSTLDiagnostics } from "../lib/stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../lib/stl-diagnostics/types";
import { planOptimize } from "../lib/mesh-optimization/plan";
import { optimizeSTL } from "../lib/mesh-optimization/optimize";
import { toSTLOptimizeSafeError } from "../lib/mesh-optimization/errors";
import { DEFAULT_OPTIMIZE_LIMITS, type OptimizeSettings } from "../lib/mesh-optimization/types";

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

interface ProcessOptions {
  mode?: "plan" | "optimize";
  settings?: OptimizeSettings;
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const isCancelled = (): boolean => cancelledRequestIds.has(requestId);
  const processOptions = message.options as ProcessOptions;

  try {
    postProgress(requestId, "reading-stl");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    const stl = parseSTL(buffer, DEFAULT_STL_LIMITS);
    if (isCancelled()) return postCancelled(requestId);

    const settings = processOptions.settings;
    if (!settings) throw new Error(`${processOptions.mode ?? "optimize"} mode requires settings`);

    if (processOptions.mode === "plan") {
      postProgress(requestId, "checking-source-mesh");
      const diagnostics = await analyzeSTLDiagnostics(stl.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS, { isCancelled, onProgress: (stage) => postProgress(requestId, stage) });
      if (isCancelled()) return postCancelled(requestId);
      const plan = planOptimize(diagnostics, settings, DEFAULT_OPTIMIZE_LIMITS.minTrianglesPerShellFloor);
      postProgress(requestId, "ready");
      const response: WorkerResponse = { type: "result", requestId, result: { mode: "plan", plan } };
      self.postMessage(response);
      return;
    }

    const result = await optimizeSTL(stl.positions, settings, DEFAULT_OPTIMIZE_LIMITS, {
      isCancelled,
      onProgress: (stage) => postProgress(requestId, stage),
    });
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "ready");

    const response: WorkerResponse = { type: "result", requestId, result: { mode: "optimize", optimize: result } };
    const transfer: Transferable[] = [];
    if (result.outputBytes) transfer.push(result.outputBytes);
    self.postMessage(response, transfer);
  } catch (error) {
    if (error instanceof CancellationRequested) return postCancelled(requestId);
    const safe = toSTLOptimizeSafeError(error);
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
