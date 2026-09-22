import type { ErrorCode } from "../errors";

export type WorkerRequestId = string;

export type WorkerRequest =
  | { type: "initialize"; requestId: WorkerRequestId }
  | {
      type: "process";
      requestId: WorkerRequestId;
      fileName: string;
      format: string;
      buffer: ArrayBuffer;
      options: Record<string, unknown>;
    }
  | { type: "cancel"; requestId: WorkerRequestId }
  | { type: "dispose"; requestId: WorkerRequestId };

export type WorkerResponse =
  | { type: "ready"; requestId: WorkerRequestId }
  | {
      type: "progress";
      requestId: WorkerRequestId;
      stage: string;
      completed: number;
      total?: number;
    }
  | { type: "result"; requestId: WorkerRequestId; result: unknown }
  | {
      type: "error";
      requestId: WorkerRequestId;
      code: ErrorCode;
      message: string;
      recoverable: boolean;
    }
  | { type: "cancelled"; requestId: WorkerRequestId };

/** Runtime guard for messages arriving from a Worker — `postMessage` payloads are untyped at the boundary. */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string") return false;

  switch (v.type) {
    case "ready":
    case "cancelled":
      return true;
    case "progress":
      return typeof v.stage === "string" && typeof v.completed === "number";
    case "result":
      return "result" in v;
    case "error":
      return typeof v.code === "string" && typeof v.message === "string" && typeof v.recoverable === "boolean";
    default:
      return false;
  }
}

export function createRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
