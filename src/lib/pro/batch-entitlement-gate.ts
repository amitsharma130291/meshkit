/**
 * The lightweight, ALWAYS-bundled half of a page's batch integration.
 * Every batch-capable page's `_client.ts` calls `initBatchEntitlementGate`
 * directly (cheap: entitlement/capability logic only, no queue/scheduler/
 * adapter/fflate code). The heavy batch engine
 * (`batch-workspace-client.ts`, which pulls in the whole `src/lib/batch/`
 * tree and `fflate`) is only ever reached through a dynamic `import()`
 * from here, and ONLY once the capability check itself confirms Pro —
 * a Free user's page load never fetches it, satisfying "do not load the
 * batch chunk until the user opens Batch and has the capability."
 *
 * Entitlement is an EXPLICIT constructor dependency, never something
 * this module resolves itself from a query string, URL fragment,
 * storage, or global — a production `_client.ts` passes
 * `createProductionEntitlementProvider()`; a test or browser
 * verification harness passes `createTestEntitlementProvider(...)`
 * directly. This module contains no branch that could ever choose
 * differently on its own — see `batch-entitlement-gate.test.ts`'s
 * source-level guarantee tests.
 */
import type { EntitlementProvider } from "./entitlement-types";
import type { ProCapability } from "./capabilities";
import { EntitlementStore } from "./entitlement-store";
import { FeatureGate } from "./feature-gate";
import type { BatchOperationId } from "../batch/types";
import type { InitBatchWorkspaceEngine } from "./batch-workspace-client";

export function initBatchEntitlementGate(root: HTMLElement, operationId: BatchOperationId, capability: ProCapability, entitlementProvider: EntitlementProvider): void {
  const tabSingle = root.querySelector<HTMLButtonElement>('[data-batch-tab="single"]');
  const tabBatch = root.querySelector<HTMLButtonElement>('[data-batch-tab="batch"]');
  const panelBatch = root.querySelector<HTMLElement>('[data-batch-panel="batch"]');
  const lockedSlot = root.querySelector<HTMLElement>("[data-batch-locked-slot]");
  const unlockedContent = root.querySelector<HTMLElement>("[data-batch-unlocked-content]");
  if (!tabSingle || !tabBatch || !panelBatch || !lockedSlot || !unlockedContent) return;

  const entitlementStore = new EntitlementStore(entitlementProvider);
  const gate = new FeatureGate(entitlementStore);

  let engine: InitBatchWorkspaceEngine | null = null;
  let engineLoading = false;

  function applyLockState(): void {
    const unlocked = gate.can(capability);
    lockedSlot!.hidden = unlocked;
    unlockedContent!.hidden = !unlocked;

    if (!unlocked || engine || engineLoading) return;
    engineLoading = true;
    void import("./batch-workspace-client").then(({ initBatchWorkspaceEngine }) => {
      engineLoading = false;
      engine = initBatchWorkspaceEngine;
      initBatchWorkspaceEngine(root, operationId, entitlementStore, gate);
    });
  }
  applyLockState();
  gate.subscribe(applyLockState);

  tabSingle.addEventListener("click", () => {
    tabSingle.setAttribute("aria-selected", "true");
    tabSingle.removeAttribute("tabindex");
    tabBatch.setAttribute("aria-selected", "false");
    tabBatch.tabIndex = -1;
    panelBatch.hidden = true;
  });
  tabBatch.addEventListener("click", () => {
    tabBatch.setAttribute("aria-selected", "true");
    tabBatch.removeAttribute("tabindex");
    tabSingle.setAttribute("aria-selected", "false");
    tabSingle.tabIndex = -1;
    panelBatch.hidden = false;
  });

  window.addEventListener("pagehide", () => entitlementStore.dispose());
}
