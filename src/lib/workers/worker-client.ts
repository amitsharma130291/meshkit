import { createSafeError, type SafeError } from "../errors";
import { createRequestId, isWorkerResponse, type WorkerRequest, type WorkerResponse } from "./protocol";

/**
 * The subset of the DOM `Worker` interface this client needs. Abstracting
 * it lets tests supply a fake worker without a browser, and would let a
 * future implementation swap in a different transport without touching
 * call sites.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface WorkerClientEvents {
  onReady?: () => void;
  onProgress?: (stage: string, completed: number, total?: number) => void;
  onResult?: (result: unknown) => void;
  onError?: (error: SafeError) => void;
  onCancelled?: () => void;
}

/**
 * Typed request/response correlation on top of a raw Worker. Tracks the
 * initialize handshake and the currently active "process" request
 * separately, so a late response for a file the user has since replaced
 * (a stale `requestId`) is silently dropped instead of overwriting newer
 * state — see the "stale request protection" tests.
 */
export class WorkerClient {
  private worker: WorkerLike | null = null;
  private initializeRequestId: string | null = null;
  private activeProcessRequestId: string | null = null;

  constructor(
    private readonly factory: WorkerFactory,
    private readonly events: WorkerClientEvents = {},
  ) {}

  initialize(): string {
    let worker: WorkerLike;
    try {
      worker = this.factory();
    } catch {
      this.events.onError?.(createSafeError("WORKER_INIT_FAILED"));
      throw createSafeError("WORKER_INIT_FAILED");
    }

    this.worker = worker;
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = () => {
      this.events.onError?.(createSafeError("WORKER_CRASHED"));
    };

    const requestId = createRequestId();
    this.initializeRequestId = requestId;
    worker.postMessage({ type: "initialize", requestId });
    return requestId;
  }

  process(fileName: string, format: string, buffer: ArrayBuffer, options: Record<string, unknown> = {}): string {
    if (!this.worker) {
      throw new Error("WorkerClient.process() called before initialize()");
    }
    const requestId = createRequestId();
    this.activeProcessRequestId = requestId;
    this.worker.postMessage({ type: "process", requestId, fileName, format, buffer, options }, [buffer]);
    return requestId;
  }

  cancel(): void {
    if (!this.worker || !this.activeProcessRequestId) return;
    this.worker.postMessage({ type: "cancel", requestId: this.activeProcessRequestId });
  }

  /** Terminates the worker and drops all tracked request state. Safe to call more than once. */
  dispose(): void {
    if (this.worker) {
      const requestId = this.activeProcessRequestId ?? this.initializeRequestId;
      if (requestId) {
        try {
          this.worker.postMessage({ type: "dispose", requestId });
        } catch {
          // Worker may already be unusable; termination below still proceeds.
        }
      }
      this.worker.terminate();
    }
    this.worker = null;
    this.initializeRequestId = null;
    this.activeProcessRequestId = null;
  }

  private handleMessage(data: unknown): void {
    if (!isWorkerResponse(data)) return;

    if (data.type === "ready") {
      if (data.requestId !== this.initializeRequestId) return; // stale handshake
      this.events.onReady?.();
      return;
    }

    if (data.requestId !== this.activeProcessRequestId) return; // stale / superseded process request

    switch (data.type) {
      case "progress":
        this.events.onProgress?.(data.stage, data.completed, data.total);
        break;
      case "result":
        this.events.onResult?.(data.result);
        this.activeProcessRequestId = null;
        break;
      case "error":
        this.events.onError?.({ code: data.code, message: data.message, recoverable: data.recoverable });
        this.activeProcessRequestId = null;
        break;
      case "cancelled":
        this.events.onCancelled?.();
        this.activeProcessRequestId = null;
        break;
    }
  }
}
