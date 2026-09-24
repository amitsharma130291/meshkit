import type { EntitlementProvider, EntitlementSnapshot } from "./entitlement-types";

export interface EntitlementProviderController extends EntitlementProvider {
  /** Pushes a new resolved snapshot immediately and notifies every current subscriber. */
  resolve(snapshot: EntitlementSnapshot): void;
  /**
   * Registers an in-flight async resolution. Only the MOST RECENTLY
   * requested `resolveAsync` call is allowed to apply its result — an
   * older call that happens to settle later is silently ignored, the
   * same generation-counter pattern this project's `WorkerClient`
   * already uses to drop a stale worker response.
   */
  resolveAsync(pending: Promise<EntitlementSnapshot>): void;
}

/**
 * The shared subscriber-management/staleness-guard implementation both
 * `production-provider.ts` and `test-provider.ts` build on, so neither
 * has to reimplement disposal or async-staleness handling itself.
 */
export function createEntitlementProvider(initial: EntitlementSnapshot): EntitlementProviderController {
  let snapshot = initial;
  let disposed = false;
  let generation = 0;
  const listeners = new Set<(snapshot: EntitlementSnapshot) => void>();

  function notify(): void {
    for (const listener of listeners) listener(snapshot);
  }

  return {
    getSnapshot(): EntitlementSnapshot {
      return snapshot;
    },
    subscribe(listener: (snapshot: EntitlementSnapshot) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve(next: EntitlementSnapshot): void {
      if (disposed) return;
      generation++;
      snapshot = next;
      notify();
    },
    resolveAsync(pending: Promise<EntitlementSnapshot>): void {
      if (disposed) return;
      const requestedGeneration = ++generation;
      void pending.then((next) => {
        if (disposed || requestedGeneration !== generation) return;
        snapshot = next;
        notify();
      });
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
    },
  };
}
