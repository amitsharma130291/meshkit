/// <reference lib="webworker" />
/**
 * Converts a PLY file to binary STL entirely inside this worker — header
 * parsing, schema resolution, ASCII/binary body reading, face
 * triangulation and STL serialization all happen here. Only the final
 * positions/normals/STL buffers cross back to the main thread, as
 * transferables; the original PLY buffer and every intermediate parsing
 * structure stay local to this function and become eligible for garbage
 * collection once it returns.
 *
 * Stages are honest about what actually happens in one forward pass — see
 * `src/lib/ply/parser.ts`'s module doc: vertex reading, face reading and
 * face triangulation are one interleaved pass (each face is triangulated
 * immediately after its own indices are read), not three separable
 * stages, the same principle `src/workers/obj-to-stl.worker.ts` already
 * documents for OBJ's own single-pass parser.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { resolvePLYSchema, readPLYBody } from "../lib/ply/parser";
import { buildPLYGeometry } from "../lib/ply/convert";
import { PLYParseException, plyError, toPLYSafeError } from "../lib/ply/errors";
import { DEFAULT_PLY_LIMITS } from "../lib/ply/types";
import type { PLYToSTLResult } from "../lib/ply/types";
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
  if (error instanceof PLYParseException) return toPLYSafeError(error);
  return toSTLSafeError(error); // handles STLParseException (e.g. serialization failure) and falls back to UNKNOWN_ERROR
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading-header");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "validating-schema");
    const schema = resolvePLYSchema(buffer, DEFAULT_PLY_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "reading-geometry");
    const doc = readPLYBody(schema, buffer, DEFAULT_PLY_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    const parsed = buildPLYGeometry(doc, DEFAULT_PLY_LIMITS);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    const expectedStlBytes = HEADER_BYTES + 4 + parsed.triangleCount * RECORD_BYTES;
    if (expectedStlBytes > DEFAULT_PLY_LIMITS.maxStlBytes) {
      throw plyError("PLY_COMPLEXITY_LIMIT");
    }

    postProgress(requestId, "serializing-stl");
    const stlBuffer = serializeBinarySTL({
      positions: parsed.positions,
      normals: parsed.normals,
      header: "MeshWrench PLY to STL conversion",
    });

    const result: PLYToSTLResult = { ...parsed, stlBuffer };

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
