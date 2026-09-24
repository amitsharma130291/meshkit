/**
 * Optimization-specific glue between `BatchPlanWorkspace.astro` (with
 * `BatchOptimizeSettings.astro` slotted in) and the shared plan-
 * workspace engine — reads the quality-preset/target controls into a
 * real `OptimizeSettings` object, wires the local preset store, and
 * formats a `BatchOptimizePlanSummary` for display.
 */
import { planOptimizeFile, type BatchOptimizePlanSummary } from "../batch/optimize-plan";
import { PresetStore, type StoredPreset } from "../batch/presets";
import type { OptimizeSettings } from "../mesh-optimization/types";
import type { EntitlementProvider } from "./entitlement-types";
import { EntitlementStore } from "./entitlement-store";
import { FeatureGate } from "./feature-gate";
import { initBatchPlanEntitlementGate } from "./batch-plan-entitlement-gate";
import type { PlanSummaryText } from "./batch-plan-workspace-client";
import { queryPresetManagerElements, wirePresetManagerUI } from "./preset-manager-ui";

const VALID_PRESETS = new Set(["preserve-details", "balanced", "maximum-reduction"]);

function validateOptimizeSettings(raw: unknown): OptimizeSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.preset !== "string" || !VALID_PRESETS.has(v.preset)) return null;
  if (typeof v.target !== "object" || v.target === null) return null;
  const target = v.target as Record<string, unknown>;
  if ((target.mode !== "percentage" && target.mode !== "triangle-count") || typeof target.value !== "number") return null;
  return raw as OptimizeSettings;
}

function renderOptimizePlanSummary(plan: BatchOptimizePlanSummary): PlanSummaryText {
  return {
    issues: plan.reasons.length > 0 ? plan.reasons.join(", ") : "None detected.",
    planned: `Target: ${plan.targetTriangleCount.toLocaleString()} triangles (from ${plan.sourceTriangleCount.toLocaleString()})`,
    skipped: plan.eligibility === "eligible" ? "None." : "Optimization itself (see eligibility).",
    eligibility: plan.eligibility,
    warnings: plan.reasons.join(", "),
  };
}

export function initBatchOptimizePlanClient(root: HTMLElement, entitlementProvider: EntitlementProvider): void {
  const presetChoice = root.querySelector<HTMLElement>("[data-batch-optimize-preset-choice]");
  const targetMode = root.querySelector<HTMLSelectElement>('[data-action="batch-target-mode"]');
  const targetValue = root.querySelector<HTMLInputElement>('[data-action="batch-target-value"]');
  const targetValueLabel = root.querySelector<HTMLElement>("[data-target-value-label]");
  const presetRow = root.querySelector<HTMLElement>("[data-batch-preset-row]");
  const presetSelect = root.querySelector<HTMLSelectElement>("[data-batch-preset-select]");
  const savePresetButton = root.querySelector<HTMLButtonElement>('[data-action="save-preset"]');

  if (!presetChoice || !targetMode || !targetValue) return;
  const presetChoiceEl = presetChoice;
  const targetModeEl = targetMode;
  const targetValueEl = targetValue;

  targetModeEl.addEventListener("change", () => {
    if (targetValueLabel) targetValueLabel.textContent = targetModeEl.value === "percentage" ? "Target percentage (%)" : "Target triangle count";
  });

  function getSettings(): OptimizeSettings {
    const preset = (presetChoiceEl.querySelector<HTMLInputElement>('input[name="batch-optimize-preset"]:checked')?.value ?? "balanced") as OptimizeSettings["preset"];
    const mode = targetModeEl.value as "percentage" | "triangle-count";
    const value = Number(targetValueEl.value) || (mode === "percentage" ? 50 : 1000);
    return { preset, target: { mode, value } };
  }

  // --- Presets --------------------------------------------------------------
  const gate = new FeatureGate(new EntitlementStore(entitlementProvider));
  const presetStore = new PresetStore<OptimizeSettings>({
    storage: window.localStorage,
    operationKind: "optimize",
    validateSettings: validateOptimizeSettings,
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
    const preset = presetStore.list().find((p: StoredPreset<OptimizeSettings>) => p.id === presetSelect.value);
    if (!preset) return;
    const radio = presetChoiceEl.querySelector<HTMLInputElement>(`input[value="${preset.settings.preset}"]`);
    if (radio) radio.checked = true;
    targetModeEl.value = preset.settings.target.mode;
    targetValueEl.value = String(preset.settings.target.value);
  });

  savePresetButton?.addEventListener("click", () => {
    const name = window.prompt("Name this preset:");
    if (!name) return;
    const created = presetStore.create(name, getSettings());
    if (created) renderPresetOptions();
  });

  wirePresetManagerUI(queryPresetManagerElements(root), presetStore, "optimize", renderPresetOptions);

  window.addEventListener("pagehide", () => presetStore.dispose());

  // --- Wire the plan-workspace engine ---------------------------------------------------------
  initBatchPlanEntitlementGate<OptimizeSettings, BatchOptimizePlanSummary>(root, "batch-optimization", entitlementProvider, () => ({
    operationId: "optimize-stl",
    capability: "batch-optimization",
    planFile: planOptimizeFile,
    getSettings,
    renderPlanSummary: renderOptimizePlanSummary,
  }));
}
