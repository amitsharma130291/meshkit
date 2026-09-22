/// <reference lib="webworker" />
/**
 * Converts an STL file to 3MF entirely inside this worker — parsing
 * (reusing the existing STL parser unchanged), degenerate-triangle
 * filtering, exact vertex deduplication, 3MF model-XML generation and
 * ZIP packaging all happen here. Only the final positions/normals/3MF
 * buffers cross back to the main thread, as transferables; the original
 * STL buffer and every intermediate structure (the dedup map, the
 * line-array XML builder, the ZIP file map) stay local to this function
 * and become eligible for garbage collection once it returns.
 */
import type { WorkerRequest, WorkerResponse } from "../lib/workers/protocol";
import { parseSTL } from "../lib/stl/parse";
import { STLParseException, toSTLSafeError } from "../lib/stl/errors";
import { filterDegenerateTriangles } from "../lib/stl/degenerate";
import { deduplicateStep, verifyPackageOutput } from "../lib/stl-to-threemf/convert";
import { toSTLToThreeMFSafeError, STLToThreeMFException } from "../lib/stl-to-threemf/errors";
import { writeModelXML } from "../lib/threemf/model-writer";
import { writeThreeMFPackage } from "../lib/threemf/package-writer";
import { ThreeMFParseException, threeMFError, toThreeMFSafeError } from "../lib/threemf/errors";
import { DEFAULT_STL_TO_THREEMF_LIMITS } from "../lib/stl-to-threemf/types";
import type { STLToThreeMFResult } from "../lib/stl-to-threemf/types";
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
  if (error instanceof STLToThreeMFException) return toSTLToThreeMFSafeError(error);
  if (error instanceof ThreeMFParseException) return toThreeMFSafeError(error);
  if (error instanceof STLParseException) return toSTLSafeError(error);
  return toSTLSafeError(error); // falls back to UNKNOWN_ERROR for anything else
}

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
    const parsed = parseSTL(buffer, DEFAULT_STL_TO_THREEMF_LIMITS.stl);
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "filtering-degenerate-facets");
    const filtered = filterDegenerateTriangles(parsed);
    if (filtered.positions.length === 0) {
      throw threeMFError("THREEMF_NO_OUTPUT_GEOMETRY");
    }
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "deduplicating-vertices");
    const geometry = await deduplicateStep(filtered.positions, DEFAULT_STL_TO_THREEMF_LIMITS.dedup, { isCancelled });
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "writing-model-xml");
    const modelXML = await writeModelXML(geometry, DEFAULT_STL_TO_THREEMF_LIMITS.model, { isCancelled });
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "writing-package-metadata");
    await yieldToEventLoop();
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "compressing-package");
    const threeMFBuffer = writeThreeMFPackage(modelXML, DEFAULT_STL_TO_THREEMF_LIMITS.package);
    if (isCancelled()) return postCancelled(requestId);

    postProgress(requestId, "verifying-output");
    verifyPackageOutput(threeMFBuffer, modelXML.length, DEFAULT_STL_TO_THREEMF_LIMITS.package);

    const outputTriangleCount = geometry.triangleVertexIndices.length / 3;

    const result: STLToThreeMFResult = {
      positions: filtered.positions,
      normals: filtered.normals,
      threeMFBuffer,
      inputEncoding: parsed.encoding,
      inputTriangleCount: parsed.triangleCount,
      outputTriangleCount,
      sourceTriangleVertexCount: geometry.sourceVertexCount,
      uniqueVertexCount: geometry.uniqueVertexCount,
      duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
      skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
      declaredUnit: "millimeter",
      coordinateScale: 1,
      outputByteLength: threeMFBuffer.byteLength,
      bounds: filtered.bounds,
      warnings:
        filtered.skippedDegenerateTriangles > 0
          ? [
              {
                code: "degenerate-triangles-skipped",
                message: "Zero-area STL facets cannot produce a useful 3MF surface and were omitted.",
              },
            ]
          : [],
    };

    postProgress(requestId, "complete");

    const response: WorkerResponse = { type: "result", requestId, result };
    self.postMessage(response, [result.positions.buffer, result.normals.buffer, result.threeMFBuffer]);
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
