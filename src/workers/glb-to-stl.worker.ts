/// <reference lib="webworker" />
/**
 * Converts a GLB file to binary STL entirely inside this worker —
 * container framing, glTF JSON validation, accessor decoding, node-graph
 * traversal and STL serialization all happen here. Only the final
 * positions/normals/STL buffers cross back to the main thread, as
 * transferables; the original GLB buffer, the decoded JSON text and every
 * intermediate accessor/scene structure stay local to this function and
 * become eligible for garbage collection once it returns.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseGLB } from "../lib/glb/convert";
import { decodeMeshes } from "../lib/glb/primitives";
import { resolveGLBScene } from "../lib/glb/resolve-scene";
import { GLBParseException, glbError, toGLBSafeError } from "../lib/glb/errors";
import { DEFAULT_GLB_LIMITS } from "../lib/glb/types";
import type { GLBToSTLResult } from "../lib/glb/types";
import { serializeBinarySTL } from "../lib/stl/serialize-binary";
import { toSTLSafeError } from "../lib/stl/errors";
import type { SafeError } from "../lib/errors";

declare const self: DedicatedWorkerGlobalScope;

const cancelledRequestIds = new Set<string>();
const HEADER_BYTES = 80;
const RECORD_BYTES = 50;

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
  return toSTLSafeError(error); // handles STLParseException (e.g. serialization failure) and falls back to UNKNOWN_ERROR
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading-container");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-header");
    // parseGLB() covers header/chunk validation AND JSON-schema parsing —
    // both are cheap, single-pass steps, so one real function call
    // legitimately spans the "validating-header"/"parsing-json" stages.
    const { doc, bin } = parseGLB(buffer, DEFAULT_GLB_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing-json");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-resources");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-accessors");
    const { meshes, skippedUnsupportedPrimitiveCount } = decodeMeshes(doc, bin, DEFAULT_GLB_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "resolving-scene");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    const scene = resolveGLBScene(doc, meshes, DEFAULT_GLB_LIMITS, skippedUnsupportedPrimitiveCount);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    const expectedStlBytes = HEADER_BYTES + 4 + scene.triangleCount * RECORD_BYTES;
    if (expectedStlBytes > DEFAULT_GLB_LIMITS.maxStlBytes) {
      throw glbError("GLB_COMPLEXITY_LIMIT");
    }

    postProgress(requestId, "serializing-stl");
    const stlBuffer = serializeBinarySTL({
      positions: scene.positions,
      normals: scene.normals,
      header: "MeshWrench GLB to STL conversion",
    });

    const result: GLBToSTLResult = {
      ...scene,
      stlBuffer,
      sourceUnits: "meter",
      outputScale: "millimeter",
      scaleFactor: 1000,
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
