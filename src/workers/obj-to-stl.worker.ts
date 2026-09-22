/// <reference lib="webworker" />
/**
 * Converts an OBJ file to binary STL entirely inside this worker — text
 * decoding, line-oriented parsing, polygon triangulation and STL
 * serialization all happen here. Only the final positions/normals/STL
 * buffers cross back to the main thread, as transferables; the decoded
 * source text and every intermediate parsing structure stay local to this
 * function and become eligible for garbage collection once it returns.
 *
 * Stages are honest about what actually happens in one forward pass —
 * OBJ vertices and faces can legally interleave (negative face indices
 * resolve against counts AT THAT POINT in the file), so parsing is a
 * single pass rather than separate "vertices" / "faces" phases.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { decodeOBJText } from "../lib/obj/tokenizer";
import { parseOBJDocument } from "../lib/obj/parser";
import { buildOBJGeometry } from "../lib/obj/convert";
import { OBJParseException, toOBJSafeError } from "../lib/obj/errors";
import { DEFAULT_OBJ_LIMITS } from "../lib/obj/types";
import type { OBJToSTLResult } from "../lib/obj/types";
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
  if (error instanceof OBJParseException) return toOBJSafeError(error);
  return toSTLSafeError(error); // handles STLParseException (e.g. serialization failure) and falls back to UNKNOWN_ERROR
}

async function handleProcess(message: Extract<WorkerRequest, { type: "process" }>): Promise<void> {
  const { requestId, buffer } = message;

  try {
    postProgress(requestId, "reading");
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "decoding");
    const text = decodeOBJText(buffer, DEFAULT_OBJ_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "parsing");
    const doc = parseOBJDocument(text, DEFAULT_OBJ_LIMITS);
    await yieldToEventLoop();
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "building-geometry");
    const parsed = buildOBJGeometry(doc, DEFAULT_OBJ_LIMITS);
    if (cancelledRequestIds.has(requestId)) return postCancelled(requestId);

    postProgress(requestId, "serializing-stl");
    const stlBuffer = serializeBinarySTL({
      positions: parsed.positions,
      normals: parsed.normals,
      header: "MeshKit OBJ to STL conversion",
    });

    const result: OBJToSTLResult = { ...parsed, stlBuffer };

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
