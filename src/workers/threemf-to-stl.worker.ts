/// <reference lib="webworker" />
/**
 * Converts a 3MF package to binary STL entirely inside this worker —
 * ZIP extraction, relationship resolution, XML parsing and scene
 * resolution all happen here. Only the final positions/normals/STL
 * buffers cross back to the main thread, as transferables; the original
 * package buffer and every intermediate structure stay local to this
 * function and become eligible for garbage collection once it returns.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { openThreeMFPackage } from "../lib/threemf/package";
import { findPrimaryModelPath } from "../lib/threemf/relationships";
import { parseThreeMFModel } from "../lib/threemf/model-parser";
import { resolveScene } from "../lib/threemf/resolve-scene";
import { ThreeMFParseException, threeMFError, toThreeMFSafeError } from "../lib/threemf/errors";
import { DEFAULT_THREEMF_LIMITS } from "../lib/threemf/types";
import type { ThreeMFToSTLResult } from "../lib/threemf/types";
import { serializeBinarySTL } from "../lib/stl/serialize-binary";
import { toSTLSafeError } from "../lib/stl/errors";
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
  return toSTLSafeError(error); // handles STLParseException (e.g. serialization failure) and falls back to UNKNOWN_ERROR
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading-package");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-package");
    const pkg = openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "locating-model");
    const modelPath = findPrimaryModelPath(pkg);
    const modelBytes = pkg.readEntry(modelPath);
    if (modelBytes.byteLength > DEFAULT_THREEMF_LIMITS.maxModelXmlBytes) {
      throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
    }
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing-model");
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(modelBytes);
    const model = parseThreeMFModel(xml, DEFAULT_THREEMF_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-components");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    const scene = resolveScene(model, DEFAULT_THREEMF_LIMITS);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "serializing-stl");
    const stlBuffer = serializeBinarySTL({
      positions: scene.positions,
      normals: scene.normals,
      header: "MeshKit 3MF to STL conversion",
    });

    const result: ThreeMFToSTLResult = {
      positions: scene.positions,
      normals: scene.normals,
      stlBuffer,
      triangleCount: scene.triangleCount,
      objectCount: scene.objectCount,
      buildItemCount: scene.buildItemCount,
      componentInstanceCount: scene.componentInstanceCount,
      sourceUnit: model.unit,
      outputScale: "millimeter",
      bounds: scene.bounds,
      warnings: scene.warnings,
    };

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    self.postMessage(response, [result.positions.buffer, result.normals.buffer, result.stlBuffer]);
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
