/// <reference lib="webworker" />
/**
 * Parses an OBJ file for the viewer entirely inside this worker — text
 * decoding, line-oriented parsing, per-corner normal resolution, scene
 * segmentation and line/point geometry assembly all happen here. Only the
 * final typed arrays and bounded metadata cross back to the main thread.
 *
 * Mirrors obj-to-stl.worker.ts's shape (same stage-boundary cancellation
 * checks; OBJ's reader side has never threaded cancellation into the
 * single-pass parse loop itself — see that worker and
 * src/lib/obj/viewer-geometry.ts for why), but ends at
 * `buildOBJViewerGeometry()`'s `OBJViewerResult` instead of a
 * `serializeBinarySTL()` call — a viewer never produces a downloadable
 * file.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { decodeOBJText } from "../lib/obj/tokenizer";
import { parseOBJViewerDocument, buildOBJViewerGeometry } from "../lib/obj/viewer-geometry";
import { OBJParseException, toOBJSafeError } from "../lib/obj/errors";
import { DEFAULT_OBJ_VIEWER_LIMITS } from "../lib/obj/viewer-types";
import type { OBJViewerResult } from "../lib/obj/viewer-types";
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
  if (error instanceof OBJParseException) return toOBJSafeError(error);
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", recoverable: true };
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "decoding");
    const text = decodeOBJText(buffer, DEFAULT_OBJ_VIEWER_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing-faces");
    const doc = parseOBJViewerDocument(text, DEFAULT_OBJ_VIEWER_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-segments");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-viewer-geometry");
    const result: OBJViewerResult = buildOBJViewerGeometry(doc, DEFAULT_OBJ_VIEWER_LIMITS);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    const transfer: Transferable[] = [result.positions.buffer, result.normals.buffer, result.flatNormals.buffer];
    if (result.lineGeometry) transfer.push(result.lineGeometry.buffer);
    if (result.pointGeometry) transfer.push(result.pointGeometry.buffer);
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
