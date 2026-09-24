/**
 * The lightweight, ALWAYS-bundled half of a planning-capable page's
 * batch integration (STL Repair, STL Optimization) — same shape and
 * same guarantee as `batch-entitlement-gate.ts`: entitlement is an
 * EXPLICIT constructor dependency (never a query string/URL fragment/
 * storage/global), and the heavy plan-workspace engine
 * (`batch-plan-workspace-client.ts`) is only ever dynamically imported
 * once the capability check itself confirms Pro.
 */
import type { EntitlementProvider } from "./entitlement-types";
import { EntitlementStore } from "./entitlement-store";
import { FeatureGate } from "./feature-gate";
import type { BatchPlanEngineConfig, InitBatchPlanWorkspaceEngine } from "./batch-plan-workspace-client";

export function initBatchPlanEntitlementGate<TSettings, TPlan>(
  root: HTMLElement,
  capability: string,
  entitlementProvider: EntitlementProvider,
  buildConfig: () => BatchPlanEngineConfig<TSettings, TPlan>,
): void {
  const tabSingle = root.querySelector<HTMLButtonElement>('[data-batch-tab="single"]');
  const tabBatch = root.querySelector<HTMLButtonElement>('[data-batch-tab="batch"]');
  const panelBatch = root.querySelector<HTMLElement>('[data-batch-panel="batch"]');
  const lockedSlot = root.querySelector<HTMLElement>("[data-batch-locked-slot]");
  const unlockedContent = root.querySelector<HTMLElement>("[data-batch-unlocked-content]");
  if (!tabSingle || !tabBatch || !panelBatch || !lockedSlot || !unlockedContent) return;

  const entitlementStore = new EntitlementStore(entitlementProvider);
  const gate = new FeatureGate(entitlementStore);

  let engine: InitBatchPlanWorkspaceEngine | null = null;
  let engineLoading = false;

  function applyLockState(): void {
    const unlocked = gate.can(capability as never);
    lockedSlot!.hidden = unlocked;
    unlockedContent!.hidden = !unlocked;

    if (!unlocked || engine || engineLoading) return;
    engineLoading = true;
    void import("./batch-plan-workspace-client").then(({ initBatchPlanWorkspaceEngine }) => {
      engineLoading = false;
      engine = initBatchPlanWorkspaceEngine as InitBatchPlanWorkspaceEngine;
      initBatchPlanWorkspaceEngine(root, buildConfig());
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
