import { freezeCapabilitySet, type ProCapability } from "./capabilities";

export type EntitlementStatus = "free" | "pro" | "unknown" | "invalid" | "expired" | "unavailable";

export type EntitlementSource = "production-default" | "test";

export interface EntitlementSnapshot {
  status: EntitlementStatus;
  capabilities: ReadonlySet<ProCapability>;
  source: EntitlementSource;
  checkedAt: number | null;
}

export interface EntitlementProvider {
  /** The current best-known snapshot, synchronously — may be stale/`"unknown"` before an async check resolves. */
  getSnapshot(): EntitlementSnapshot;
  /** Registers a listener for snapshot changes; returns an unsubscribe function. Never fires after `dispose()`. */
  subscribe(listener: (snapshot: EntitlementSnapshot) => void): () => void;
  /** Releases this provider's resources and drops every subscriber; a safe no-op if called more than once. */
  dispose(): void;
}

/**
 * The single choke point every snapshot in this project passes through.
 * Only `"pro"` may carry capabilities — every other status (`"free"`,
 * `"unknown"`, `"invalid"`, `"expired"`, `"unavailable"`) is forced to an
 * EMPTY capability set here, regardless of what's passed in, so
 * "fail closed" is a structural guarantee rather than something every
 * call site has to remember to enforce on its own.
 */
export function createSnapshot(
  status: EntitlementStatus,
  capabilities: Iterable<ProCapability>,
  source: EntitlementSource,
  checkedAt: number | null,
): EntitlementSnapshot {
  return {
    status,
    capabilities: status === "pro" ? freezeCapabilitySet(capabilities) : freezeCapabilitySet([]),
    source,
    checkedAt,
  };
}

/** The default snapshot for "no provider is available yet" — unavailable, zero capabilities, never checked. */
export const FAIL_CLOSED_SNAPSHOT: EntitlementSnapshot = createSnapshot("unavailable", [], "production-default", null);
