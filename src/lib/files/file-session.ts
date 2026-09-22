import { createSafeError } from "../errors";

/**
 * Wraps a single locally-selected `File` for the lifetime of one tool
 * interaction. Tracks every object URL it hands out and any cleanup a
 * caller registers (e.g. "cancel the worker task for this file") so a
 * single `dispose()` call releases everything associated with the file.
 *
 * A session is never persisted (no localStorage/IndexedDB/cookies) and
 * holds no reference back to the DOM beyond object URLs it created itself.
 */
export class FileSession {
  readonly id: string;
  readonly file: File;
  readonly extension: string;

  private objectUrls = new Set<string>();
  private cleanupCallbacks: Array<() => void> = [];
  private bufferRef: ArrayBuffer | null = null;
  private disposed = false;

  constructor(file: File, extension: string) {
    this.id = createSessionId();
    this.file = file;
    this.extension = extension;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Whether `readArrayBuffer()` has been called and its result is still held (i.e. not yet disposed). */
  get hasCachedBuffer(): boolean {
    return this.bufferRef !== null;
  }

  createObjectUrl(): string {
    this.assertNotDisposed();
    const url = URL.createObjectURL(this.file);
    this.objectUrls.add(url);
    return url;
  }

  async readArrayBuffer(): Promise<ArrayBuffer> {
    this.assertNotDisposed();
    try {
      const buffer = await this.file.arrayBuffer();
      this.bufferRef = buffer;
      return buffer;
    } catch {
      throw createSafeError("FILE_READ_FAILED");
    }
  }

  /** Register cleanup (e.g. `() => workerClient.cancel()`) to run when this session is disposed. */
  registerCleanup(fn: () => void): void {
    this.cleanupCallbacks.push(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.bufferRef = null;

    for (const cleanup of this.cleanupCallbacks.splice(0)) {
      try {
        cleanup();
      } catch {
        // Best-effort: one failed cleanup must not block the rest.
      }
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("FileSession already disposed");
    }
  }
}

function createSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
