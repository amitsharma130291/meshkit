import type { ProCapability } from "./capabilities";
import type { EntitlementSnapshot } from "./entitlement-types";
import type { EntitlementStore } from "./entitlement-store";

/**
 * The one function every capability check in this project should funnel
 * through. A missing snapshot (no provider/store configured yet) and
 * every non-`"pro"` status fail closed — only `"pro"` can grant
 * anything, and only a capability explicitly present in that snapshot's
 * own set.
 */
export function hasCapability(snapshot: EntitlementSnapshot | null | undefined, capability: ProCapability): boolean {
  if (!snapshot) return false;
  if (snapshot.status !== "pro") return false;
  return snapshot.capabilities.has(capability);
}

/** Thin, disposal-free wrapper pairing a store with `hasCapability` — UI code holds one of these rather than re-deriving snapshots by hand. */
export class FeatureGate {
  constructor(private readonly store: EntitlementStore) {}

  can(capability: ProCapability): boolean {
    return hasCapability(this.store.getSnapshot(), capability);
  }

  subscribe(listener: (snapshot: EntitlementSnapshot) => void): () => void {
    return this.store.subscribe(listener);
  }
}
