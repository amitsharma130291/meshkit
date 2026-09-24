/// <reference lib="webworker" />
/**
 * Resolves a GLB file for the viewer entirely inside this worker —
 * container framing, glTF JSON validation, accessor decoding, scene-graph
 * traversal, material/texture/sampler validation and embedded-image byte
 * extraction all happen here. Only the final typed arrays, bounded
 * hierarchy/material descriptors and still-encoded image bytes cross back
 * to the main thread; Three.js is never touched here (no rendering, no
 * image decoding — see docs/ARCHITECTURE.md for why decoding stays on the
 * main thread). Mirrors glb-to-stl.worker.ts's stage shape but ends at a
 * `GLBViewerResult`, never calling `serializeBinarySTL()`.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseGLBContainer } from "../lib/glb/container";
import { parseGLTFSchema } from "../lib/glb/schema";
import { checkRequiredExtensions } from "../lib/glb/convert";
import { parseGLTFViewerResources } from "../lib/glb/viewer-resources";
import { extractViewerImages } from "../lib/glb/viewer-images";
import { resolveGLBViewerScene } from "../lib/glb/viewer-scene";
import { GLBParseException, toGLBSafeError } from "../lib/glb/errors";
import { DEFAULT_GLB_VIEWER_LIMITS } from "../lib/glb/viewer-types";
import type { GLBViewerResult } from "../lib/glb/viewer-types";
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
  if (error instanceof GLBParseException) return toGLBSafeError(error);
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", recoverable: true };
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const limits = DEFAULT_GLB_VIEWER_LIMITS;

  try {
    postProgress(requestId, "reading-container");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-header");
    const { json, bin } = parseGLBContainer(buffer, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing-json");
    const doc = parseGLTFSchema(json, limits);
    checkRequiredExtensions(doc);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-resources");
    const resources = parseGLTFViewerResources(json, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-accessors");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-scene");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-primitives");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "extracting-materials");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "extracting-images");
    const extractedImages = extractViewerImages(doc, bin, resources.images, limits);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-hierarchy");
    const result: GLBViewerResult = resolveGLBViewerScene(doc, bin, resources, extractedImages, limits);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    const transfer: Transferable[] = [result.positions.buffer, result.normals.buffer, result.indices.buffer];
    if (result.texcoords0) transfer.push(result.texcoords0.buffer);
    if (result.colors0) transfer.push(result.colors0.buffer);
    if (result.lineGeometry) transfer.push(result.lineGeometry.buffer);
    if (result.lineColors) transfer.push(result.lineColors.buffer);
    if (result.pointGeometry) transfer.push(result.pointGeometry.buffer);
    if (result.pointColors) transfer.push(result.pointColors.buffer);
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
