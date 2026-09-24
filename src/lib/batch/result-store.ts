/**
 * Owns every object URL created for a batch job's downloadable output.
 * `URL.createObjectURL`/`revokeObjectURL` aren't available in this
 * project's Node-based test environment, so the factory is injected
 * (defaults to the real global `URL` at runtime) — the same dependency-
 * injection shape `worker-job-runner.test.ts` uses for `Worker`.
 *
 * Revocation triggers (all funnel through `revoke`/`revokeAll`/
 * `dispose`): a job is removed, results are cleared, a batch is
 * replaced, the page is unloaded, a ZIP finishes or fails, entitlement
 * becomes unavailable.
 */
export interface ObjectUrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export class ResultStore {
  private readonly urls = new Map<string, string>();
  private disposed = false;

  constructor(private readonly urlFactory: ObjectUrlFactory) {}

  /** Returns the existing URL for this job if one was already created, without creating a new blob. */
  getUrl(jobId: string): string | null {
    return this.urls.get(jobId) ?? null;
  }

  /** Creates (and caches) an object URL for a job's output bytes, or returns the already-cached one. Returns `null` once disposed. */
  getOrCreateUrl(jobId: string, outputBytes: ArrayBuffer, mimeType: string): string | null {
    if (this.disposed) return null;
    const existing = this.urls.get(jobId);
    if (existing) return existing;
    const url = this.urlFactory.createObjectURL(new Blob([outputBytes], { type: mimeType }));
    this.urls.set(jobId, url);
    return url;
  }

  revoke(jobId: string): void {
    const url = this.urls.get(jobId);
    if (!url) return;
    this.urlFactory.revokeObjectURL(url);
    this.urls.delete(jobId);
  }

  revokeAll(): void {
    for (const url of this.urls.values()) this.urlFactory.revokeObjectURL(url);
    this.urls.clear();
  }

  dispose(): void {
    this.revokeAll();
    this.disposed = true;
  }
}
