/**
 * An explicitly non-production entitlement provider for tests (and any
 * dev-only harness) to inject a Free/Pro/etc. state directly, without
 * going through a real payment/licensing flow — Phase 10 has neither.
 *
 * This module must NEVER be imported from a production code path (no
 * app page, no production build entry, nothing reachable from
 * `production-provider.ts`). `production-isolation.test.ts` inspects
 * the actual built bundles to prove that.
 */
import type { ProCapability } from "./capabilities";
import { createEntitlementProvider, type EntitlementProviderController } from "./entitlement-provider";
import { createSnapshot, type EntitlementStatus } from "./entitlement-types";

export interface TestEntitlementInit {
  status?: EntitlementStatus;
  capabilities?: ProCapability[];
}

export interface TestEntitlementProviderController extends EntitlementProviderController {
  /** Replaces the snapshot immediately and synchronously. */
  setSnapshot(next: TestEntitlementInit): void;
  /** Replaces the snapshot after `delayMs` — only the most recently requested call's result applies, matching `resolveAsync`'s staleness guard. */
  setSnapshotAsync(next: TestEntitlementInit, delayMs: number): Promise<void>;
}

function toSnapshot(init: TestEntitlementInit): ReturnType<typeof createSnapshot> {
  return createSnapshot(init.status ?? "free", init.capabilities ?? [], "test", Date.now());
}

export function createTestEntitlementProvider(initial: TestEntitlementInit = {}): TestEntitlementProviderController {
  const controller = createEntitlementProvider(toSnapshot(initial));

  return {
    ...controller,
    setSnapshot(next: TestEntitlementInit): void {
      controller.resolve(toSnapshot(next));
    },
    async setSnapshotAsync(next: TestEntitlementInit, delayMs: number): Promise<void> {
      const pending = new Promise<ReturnType<typeof createSnapshot>>((resolve) => {
        setTimeout(() => resolve(toSnapshot(next)), delayMs);
      });
      controller.resolveAsync(pending);
      await pending;
    },
  };
}
