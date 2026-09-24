/// <reference lib="webworker" />
/**
 * Resolves a 3MF package for the viewer entirely inside this worker — ZIP
 * extraction, relationship resolution, XML parsing, component/transform
 * resolution and color resolution all happen here. Only the final
 * positions/normals/(optional) colors and bounded metadata cross back to
 * the main thread. Mirrors threemf-to-stl.worker.ts's stage shape, but
 * ends at a `ThreeMFViewerResult` — unlike that worker, it never calls
 * `serializeBinarySTL()`, since a viewer produces no downloadable file.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { openThreeMFPackage } from "../lib/threemf/package";
import { findPrimaryModelPath } from "../lib/threemf/relationships";
import { parseThreeMFViewerModel } from "../lib/threemf/viewer-resources";
import { resolveViewerScene } from "../lib/threemf/viewer-scene";
import { ThreeMFParseException, threeMFError, toThreeMFSafeError } from "../lib/threemf/errors";
import { DEFAULT_THREEMF_VIEWER_LIMITS } from "../lib/threemf/viewer-types";
import type { ThreeMFViewerResult } from "../lib/threemf/viewer-types";
import type { SafeError } from "../lib/errors";

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

function toWorkerSafeError(error: unknown): SafeError {
  if (error instanceof ThreeMFParseException) return toThreeMFSafeError(error);
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", recoverable: true };
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading-package");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-package");
    const pkg = openThreeMFPackage(buffer, DEFAULT_THREEMF_VIEWER_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "locating-model");
    const modelPath = findPrimaryModelPath(pkg);
    const modelBytes = pkg.readEntry(modelPath);
    if (modelBytes.byteLength > DEFAULT_THREEMF_VIEWER_LIMITS.maxModelXmlBytes) {
      throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
    }
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing-model");
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(modelBytes);
    const model = parseThreeMFViewerModel(xml, DEFAULT_THREEMF_VIEWER_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-resources");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-components");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-scene");
    const result: ThreeMFViewerResult = resolveViewerScene(model, DEFAULT_THREEMF_VIEWER_LIMITS, pkg.entryNames.size);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-colors");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    const transfer: Transferable[] = [result.positions.buffer, result.normals.buffer];
    if (result.colors) transfer.push(result.colors.buffer);
    self.postMessage(response, transfer);
  } catch (error) {
    const safe = toWorkerSafeError(error);
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
