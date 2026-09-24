/// <reference lib="webworker" />
/**
 * Parses, diagnoses, plans and repairs an STL file entirely inside this
 * worker. Reuses `parseSTL()` unchanged and `repairSTL()`
 * (`src/lib/stl-repair/repair.ts`) for the actual pipeline — this worker
 * adds no logic of its own beyond message-protocol plumbing and two
 * request "modes," both delivered through the existing `process` message
 * type's own `options` field (no new protocol message types needed):
 *
 * - `options.mode === "plan"`: parse + diagnose + build the repair plan
 *   ONLY — fast, and mutates nothing. This is what powers "show the
 *   planned operations" before the user ever clicks "run repair."
 * - `options.mode === "repair"` (default): the full pipeline.
 *
 * Progress stages are relayed straight from `repairSTL()`'s own
 * `onProgress` callback (plus this worker's own `reading` stage before
 * parsing) — never a second, hand-invented stage list.
 *
 * Cancellation follows the same `isCancelled()`-closure-plus-
 * `CancellationRequested`-backstop pattern every other worker in this
 * project uses. Stale-result protection is inherited for free from the
 * existing `WorkerClient`'s own `requestId` matching — this worker
 * itself is stateless per request, so it has no callback-rebinding
 * concern to guard against in the first place (see
 * `src/pages/stl-repair/_client.ts`'s own doc comment for why the
 * CLIENT side is what actually needed the Universal Viewer's lesson
 * applied, not this worker).
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { DEFAULT_STL_LIMITS } from "../lib/stl/types";
import { CancellationRequested } from "../lib/cancellation";
import { analyzeSTLDiagnostics } from "../lib/stl-diagnostics/analyze";
import { planRepair } from "../lib/stl-repair/plan";
import { repairSTL } from "../lib/stl-repair/repair";
import { toSTLRepairSafeError } from "../lib/stl-repair/errors";
import { DEFAULT_REPAIR_LIMITS, type RepairSettings } from "../lib/stl-repair/types";

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
  mode?: "plan" | "repair";
  settings?: RepairSettings;
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const isCancelled = (): boolean => cancelledRequestIds.has(requestId);
  const processOptions = message.options as ProcessOptions;

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    const stl = parseSTL(buffer, DEFAULT_STL_LIMITS);
    if (isCancelled()) return postCancelled(requestId);

    if (processOptions.mode === "plan") {
      postProgress(requestId, "checking-original-mesh");
      const diagnostics = await analyzeSTLDiagnostics(stl.positions, DEFAULT_REPAIR_LIMITS.diagnostics, { isCancelled, onProgress: (stage) => postProgress(requestId, stage) });
      if (isCancelled()) return postCancelled(requestId);
      const settings = processOptions.settings;
      if (!settings) throw new Error("plan mode requires settings");
      const plan = planRepair(diagnostics, settings);
      postProgress(requestId, "complete");
      const response: WorkerResponse = { type: "result", requestId, result: { mode: "plan", plan } };
      self.postMessage(response);
      return;
    }

    const settings = processOptions.settings;
    if (!settings) throw new Error("repair mode requires settings");

    const result = await repairSTL(stl.positions, settings, DEFAULT_REPAIR_LIMITS, {
      isCancelled,
      onProgress: (stage) => postProgress(requestId, stage),
    });
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result: { mode: "repair", repair: result } };
    const transfer: Transferable[] = [];
    if (result.outputBytes) transfer.push(result.outputBytes);
    if (result.overlays) {
      transfer.push(
        result.overlays.removedTrianglePositions.buffer,
        result.overlays.flippedTrianglePositions.buffer,
        result.overlays.weldedVertexPositions.buffer,
        result.overlays.filledHolePositions.buffer,
        result.overlays.removedShellPositions.buffer,
        result.overlays.unresolvedBoundaryEdgeLines.buffer,
        result.overlays.unresolvedNonManifoldEdgeLines.buffer,
        result.overlays.unresolvedSelfIntersectionPositions.buffer,
      );
    }
    self.postMessage(response, transfer);
  } catch (error) {
    if (error instanceof CancellationRequested) return postCancelled(requestId);
    const safe = toSTLRepairSafeError(error);
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
