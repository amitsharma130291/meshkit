/**
 * Repair-specific glue between `BatchPlanWorkspace.astro` (with
 * `BatchRepairSettings.astro` slotted in) and the shared plan-workspace
 * engine — reads the Safe/Standard/Custom controls into a real
 * `RepairSettings` object, wires the local preset store, and formats a
 * `BatchRepairPlanSummary` for display.
 */
import { planRepairFile, type BatchRepairPlanSummary } from "../batch/repair-plan";
import { PresetStore, type StoredPreset } from "../batch/presets";
import { safePreset, standardPreset, type RepairSettings } from "../stl-repair/types";
import type { EntitlementProvider } from "./entitlement-types";
import { EntitlementStore } from "./entitlement-store";
import { FeatureGate } from "./feature-gate";
import { initBatchPlanEntitlementGate } from "./batch-plan-entitlement-gate";
import type { PlanSummaryText } from "./batch-plan-workspace-client";
import { queryPresetManagerElements, wirePresetManagerUI } from "./preset-manager-ui";

function validateRepairSettings(raw: unknown): RepairSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.preset !== "string" || typeof v.weld !== "object" || v.weld === null) return null;
  const weld = v.weld as Record<string, unknown>;
  if (typeof weld.enabled !== "boolean" || typeof weld.toleranceAbs !== "number") return null;
  return raw as RepairSettings;
}

function renderRepairPlanSummary(plan: BatchRepairPlanSummary): PlanSummaryText {
  return {
    issues: plan.detectedIssues.length > 0 ? plan.detectedIssues.join(", ") : "None detected.",
    planned: plan.plannedOperations.length > 0 ? plan.plannedOperations.join(", ") : "None.",
    skipped: plan.skippedOperations.length > 0 ? plan.skippedOperations.join(", ") : "None.",
    eligibility: plan.eligibility,
    warnings: plan.warnings.length > 0 ? plan.warnings.join(", ") : "None.",
  };
}

export function initBatchRepairPlanClient(root: HTMLElement, entitlementProvider: EntitlementProvider): void {
  const presetChoice = root.querySelector<HTMLElement>("[data-batch-repair-preset-choice]");
  const customControls = root.querySelector<HTMLFieldSetElement>("[data-batch-repair-custom-controls]");
  const weldEnabled = root.querySelector<HTMLInputElement>('[data-action="batch-custom-weld-enabled"]');
  const weldTolerance = root.querySelector<HTMLInputElement>('[data-action="batch-custom-weld-tolerance"]');
  const shellsEnabled = root.querySelector<HTMLInputElement>('[data-action="batch-custom-remove-small-shells"]');
  const shellThreshold = root.querySelector<HTMLInputElement>('[data-action="batch-custom-shell-threshold"]');
  const presetRow = root.querySelector<HTMLElement>("[data-batch-preset-row]");
  const presetSelect = root.querySelector<HTMLSelectElement>("[data-batch-preset-select]");
  const savePresetButton = root.querySelector<HTMLButtonElement>('[data-action="save-preset"]');

  if (!presetChoice || !customControls) return;
  const presetChoiceEl = presetChoice;
  const customControlsEl = customControls;

  presetChoiceEl.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name !== "batch-repair-preset") return;
    const isCustom = target.value === "custom";
    for (const control of [weldEnabled, weldTolerance, shellsEnabled, shellThreshold]) control && (control.disabled = !isCustom);
    customControlsEl.disabled = !isCustom;
  });

  function getSettings(): RepairSettings {
    const selected = presetChoiceEl.querySelector<HTMLInputElement>('input[name="batch-repair-preset"]:checked')?.value ?? "safe";
    if (selected === "safe") return safePreset();
    if (selected === "standard") return standardPreset(10);
    return {
      ...safePreset(),
      preset: "custom",
      weld: { enabled: weldEnabled?.checked ?? false, toleranceAbs: Number(weldTolerance?.value) || 0.01 },
      removeSmallShells: {
        enabled: shellsEnabled?.checked ?? false,
        criterion: "triangle-count",
        threshold: Number(shellThreshold?.value) || 4,
      },
    };
  }

  // --- Presets --------------------------------------------------------------
  const gate = new FeatureGate(new EntitlementStore(entitlementProvider));
  const presetStore = new PresetStore<RepairSettings>({
    storage: window.localStorage,
    operationKind: "repair",
    validateSettings: validateRepairSettings,
    canUsePresets: () => gate.can("saved-presets"),
  });

  function renderPresetOptions(): void {
    if (!presetSelect) return;
    const current = presetSelect.value;
    presetSelect.innerHTML = '<option value="">— none —</option>';
    for (const preset of presetStore.list()) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      presetSelect.appendChild(option);
    }
    presetSelect.value = current;
  }

  if (presetRow) presetRow.hidden = false;
  renderPresetOptions();

  presetSelect?.addEventListener("change", () => {
    const preset = presetStore.list().find((p: StoredPreset<RepairSettings>) => p.id === presetSelect.value);
    if (!preset) return;
    const customRadio = presetChoiceEl.querySelector<HTMLInputElement>('input[value="custom"]');
    if (customRadio) {
      customRadio.checked = true;
      customControlsEl.disabled = false;
      if (weldEnabled) weldEnabled.disabled = false;
      if (weldTolerance) weldTolerance.disabled = false;
      if (shellsEnabled) shellsEnabled.disabled = false;
      if (shellThreshold) shellThreshold.disabled = false;
      if (weldEnabled) weldEnabled.checked = preset.settings.weld.enabled;
      if (weldTolerance) weldTolerance.value = String(preset.settings.weld.toleranceAbs);
      if (shellsEnabled) shellsEnabled.checked = preset.settings.removeSmallShells.enabled;
      if (shellThreshold) shellThreshold.value = String(preset.settings.removeSmallShells.threshold);
    }
  });

  savePresetButton?.addEventListener("click", () => {
    const name = window.prompt("Name this preset:");
    if (!name) return;
    const created = presetStore.create(name, getSettings());
    if (created) renderPresetOptions();
  });

  wirePresetManagerUI(queryPresetManagerElements(root), presetStore, "repair", renderPresetOptions);

  window.addEventListener("pagehide", () => presetStore.dispose());

  // --- Wire the plan-workspace engine ---------------------------------------------------------
  initBatchPlanEntitlementGate<RepairSettings, BatchRepairPlanSummary>(root, "batch-repair", entitlementProvider, () => ({
    operationId: "repair-stl",
    capability: "batch-repair",
    planFile: planRepairFile,
    getSettings,
    renderPlanSummary: renderRepairPlanSummary,
  }));
}
