/// <reference lib="webworker" />
/**
 * Resolves a PLY file for the viewer entirely inside this worker — header
 * parsing, schema resolution, ASCII/binary body reading, face
 * triangulation and normal/bounds computation all happen here. Only the
 * final typed arrays and bounded metadata cross back to the main thread.
 * Stages mirror ply-to-stl.worker.ts's own naming — vertex reading, face
 * reading and face triangulation are one interleaved pass here too (see
 * viewer-scene.ts's module doc), not three separable stages, so honestly
 * reporting them means reusing the converter's own stage shape rather
 * than inventing finer-grained stages that don't correspond to real,
 * separate passes over the data. Ends at a `PLYViewerResult`, never
 * calling `serializeBinarySTL()`, since a viewer produces no downloadable
 * file.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { resolvePLYViewerSchema } from "../lib/ply/viewer-resources";
import { resolvePLYViewerScene } from "../lib/ply/viewer-scene";
import { PLYParseException, toPLYSafeError } from "../lib/ply/errors";
import { DEFAULT_PLY_VIEWER_LIMITS } from "../lib/ply/viewer-types";
import type { PLYViewerResult } from "../lib/ply/viewer-types";
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
  if (error instanceof PLYParseException) return toPLYSafeError(error);
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", recoverable: true };
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const limits = DEFAULT_PLY_VIEWER_LIMITS;

  try {
    postProgress(requestId, "reading-header");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-schema");
    const schema = resolvePLYViewerSchema(buffer, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-geometry");
    const result: PLYViewerResult = resolvePLYViewerScene(schema, buffer, limits);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    const transfer: Transferable[] = [result.positions.buffer];
    if (result.normals) transfer.push(result.normals.buffer);
    if (result.colors) transfer.push(result.colors.buffer);
    if (result.uvs) transfer.push(result.uvs.buffer);
    if (result.surfaceIndices) transfer.push(result.surfaceIndices.buffer);
    if (result.edgeIndices) transfer.push(result.edgeIndices.buffer);
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
