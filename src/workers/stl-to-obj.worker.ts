/// <reference lib="webworker" />
/**
 * Converts an STL file to OBJ entirely inside this worker — parsing
 * (reusing the existing STL parser unchanged), degenerate-triangle
 * filtering, exact vertex deduplication and OBJ text serialization all
 * happen here. Only the final positions/normals/OBJ buffers cross back to
 * the main thread, as transferables; the original STL buffer and every
 * intermediate structure (the dedup map, the line-array text builder)
 * stay local to this function and become eligible for garbage collection
 * once it returns.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { STLParseException, toSTLSafeError } from "../lib/stl/errors";
import { filterDegenerateTriangles, extractFaceNormals, deduplicateStep, serializeStep } from "../lib/stl-to-obj/convert";
import { toSTLToOBJSafeError, STLToOBJException } from "../lib/stl-to-obj/errors";
import { OBJParseException, objError, toOBJSafeError } from "../lib/obj/errors";
import { DEFAULT_STL_TO_OBJ_LIMITS } from "../lib/stl-to-obj/types";
import type { STLToOBJResult } from "../lib/stl-to-obj/types";
import { CancellationRequested } from "../lib/cancellation";
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
  if (error instanceof STLToOBJException) return toSTLToOBJSafeError(error);
  if (error instanceof OBJParseException) return toOBJSafeError(error);
  if (error instanceof STLParseException) return toSTLSafeError(error);
  return toSTLSafeError(error); // falls back to UNKNOWN_ERROR for anything else
}

const SERIALIZE_STAGE_NAMES = {
  "writing-vertices": "writing-vertices",
  "writing-normals": "writing-normals",
  "writing-faces": "writing-faces",
  "encoding-obj": "encoding-obj",
} as const;

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;
  const isCancelled = (): boolean => cancelledRequestIds.has(requestId);

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "detecting-stl-format");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "parsing-stl");
    const parsed = parseSTL(buffer, DEFAULT_STL_TO_OBJ_LIMITS.stl);
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "filtering-degenerate-facets");
    const filtered = filterDegenerateTriangles(parsed);
    if (filtered.positions.length === 0) {
      throw objError("OBJ_NO_OUTPUT_GEOMETRY");
    }
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "deduplicating-vertices");
    const geometry = await deduplicateStep(filtered.positions, DEFAULT_STL_TO_OBJ_LIMITS.dedup, { isCancelled });
    if (isCancelled()) return postCancelled(requestId);

    const faceNormals = extractFaceNormals(filtered.normals);

    const serialized = await serializeStep(geometry, faceNormals, DEFAULT_STL_TO_OBJ_LIMITS.serialize, {
      isCancelled,
      onStage: (stage) => postProgress(requestId, SERIALIZE_STAGE_NAMES[stage]),
    });
    if (isCancelled()) return postCancelled(requestId);

    const objBuffer = serialized.bytes.buffer as ArrayBuffer;

    const result: STLToOBJResult = {
      positions: filtered.positions,
      normals: filtered.normals,
      objBuffer,
      inputEncoding: parsed.encoding,
      inputTriangleCount: parsed.triangleCount,
      outputFaceCount: serialized.faceCount,
      sourceTriangleVertexCount: geometry.sourceVertexCount,
      uniqueVertexCount: geometry.uniqueVertexCount,
      duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
      skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
      outputByteLength: serialized.outputByteLength,
      bounds: filtered.bounds,
      warnings:
        filtered.skippedDegenerateTriangles > 0
          ? [
              {
                code: "degenerate-triangles-skipped",
                message: "Zero-area STL facets cannot produce a useful OBJ surface and were omitted from the download.",
              },
            ]
          : [],
    };

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    self.postMessage(response, [result.positions.buffer, result.normals.buffer, result.objBuffer]);
  } catch (error) {
    if (error instanceof CancellationRequested) return postCancelled(requestId);
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
