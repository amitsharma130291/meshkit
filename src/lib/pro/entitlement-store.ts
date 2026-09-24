import { FAIL_CLOSED_SNAPSHOT, type EntitlementProvider, type EntitlementSnapshot } from "./entitlement-types";

/**
 * The consumer-facing reactive wrapper `feature-gate.ts` and Pro UI
 * actually hold onto. Owns its OWN subscriber list (never the
 * provider's) so swapping the active provider mid-session (dev-only
 * test injection, or a future real entitlement refresh) doesn't require
 * every consumer to resubscribe. Never disposes the provider it wraps —
 * the caller that created the provider owns its lifecycle.
 */
export class EntitlementStore {
  private provider: EntitlementProvider | null = null;
  private unsubscribeFromProvider: (() => void) | null = null;
  private readonly listeners = new Set<(snapshot: EntitlementSnapshot) => void>();
  private disposed = false;

  constructor(initialProvider?: EntitlementProvider) {
    if (initialProvider) this.setProvider(initialProvider);
  }

  getSnapshot(): EntitlementSnapshot {
    if (this.disposed || !this.provider) return FAIL_CLOSED_SNAPSHOT;
    return this.provider.getSnapshot();
  }

  setProvider(provider: EntitlementProvider): void {
    if (this.disposed) return;
    this.unsubscribeFromProvider?.();
    this.provider = provider;
    this.unsubscribeFromProvider = provider.subscribe(() => this.notify());
    this.notify();
  }

  subscribe(listener: (snapshot: EntitlementSnapshot) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeFromProvider?.();
    this.unsubscribeFromProvider = null;
    this.provider = null;
    this.listeners.clear();
  }

  private notify(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
