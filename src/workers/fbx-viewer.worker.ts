/// <reference lib="webworker" />
/**
 * Resolves an FBX file for the viewer entirely inside this worker —
 * binary header/node-tree parsing, document/connection interpretation,
 * Model-hierarchy and transform resolution, geometry decode/
 * triangulation, layer-element resolution and embedded-texture-byte
 * extraction all happen here. Only the final validated metadata and
 * transferable render buffers cross back to the main thread — no
 * `THREE.*` object is ever constructed in this worker (see
 * `src/pages/fbx-viewer/_client.ts` for where Three.js objects are
 * actually built, and for the main-thread `createImageBitmap()`
 * embedded-texture decode step, mirroring the GLB viewer's own
 * worker-extracts/main-thread-decodes split).
 *
 * Stages mirror the pipeline's own real boundaries — `parseFBXBinary()`
 * (header + node tree, including any zlib-compressed array payloads,
 * which are decompressed inline as part of that same single pass, not a
 * separate stage) is genuinely separate from
 * `interpretFBXDocument()`/`buildConnectionGraph()` (objects and
 * connections), which is in turn genuinely separate from
 * `resolveFBXViewerSceneFromDocument()` (hierarchy, geometry, materials,
 * scene). Reporting progress at these three real boundaries — rather
 * than inventing finer-grained stages that don't correspond to distinct
 * passes over the data — follows the same "honest staging" convention
 * every prior viewer's own worker uses.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseFBXBinary } from "../lib/fbx/binary-parser";
import { interpretFBXDocument } from "../lib/fbx/document";
import { buildConnectionGraph } from "../lib/fbx/connections";
import { resolveFBXViewerSceneFromDocument } from "../lib/fbx/resolve-scene";
import { FBXParseException, toFBXSafeError } from "../lib/fbx/errors";
import { DEFAULT_FBX_VIEWER_LIMITS } from "../lib/fbx/viewer-types";
import type { FBXViewerResult } from "../lib/fbx/viewer-types";
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
  if (error instanceof FBXParseException) return toFBXSafeError(error);
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", recoverable: true };
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const limits = DEFAULT_FBX_VIEWER_LIMITS;

  try {
    postProgress(requestId, "validating-header");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-node-records");
    const parsed = parseFBXBinary(buffer, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-objects");
    const doc = interpretFBXDocument(parsed.version, parsed.uses64BitRecords, parsed.nodes, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-connections");
    const graph = buildConnectionGraph(doc);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    const result: FBXViewerResult = resolveFBXViewerSceneFromDocument(parsed.version, parsed.uses64BitRecords, doc, graph, limits);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "preparing-scene");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    const transfer: Transferable[] = [result.positions.buffer, result.normals.buffer, result.indices.buffer];
    if (result.uvs) transfer.push(result.uvs.buffer);
    if (result.colors) transfer.push(result.colors.buffer);
    for (const image of result.images) {
      if (image) transfer.push(image.bytes.buffer);
    }
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
