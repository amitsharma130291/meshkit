/**
 * Shared "Manage presets" panel wiring for the repair and optimize batch
 * plan clients — rename, delete, export (JSON download) and import (JSON
 * file), all going through the same `PresetStore` methods its own unit
 * tests already cover. This module owns only DOM wiring; every actual
 * read/write decision (duplicate names, capability gating, corrupted
 * import) is delegated to `PresetStore` itself.
 */
import type { PresetStore, StoredPreset } from "../batch/presets";

export interface PresetManagerElements {
  manageButton: HTMLButtonElement | null;
  closeButton: HTMLButtonElement | null;
  panel: HTMLElement | null;
  list: HTMLElement | null;
  rowTemplate: HTMLTemplateElement | null;
  status: HTMLElement | null;
  exportButton: HTMLButtonElement | null;
  importButton: HTMLButtonElement | null;
  importFileInput: HTMLInputElement | null;
}

export function queryPresetManagerElements(root: ParentNode): PresetManagerElements {
  return {
    manageButton: root.querySelector<HTMLButtonElement>('[data-action="manage-presets"]'),
    closeButton: root.querySelector<HTMLButtonElement>('[data-action="close-preset-manager"]'),
    panel: root.querySelector<HTMLElement>("[data-batch-preset-manager]"),
    list: root.querySelector<HTMLElement>("[data-preset-manager-list]"),
    rowTemplate: root.querySelector<HTMLTemplateElement>("[data-preset-manager-row-template]"),
    status: root.querySelector<HTMLElement>("[data-preset-manager-status]"),
    exportButton: root.querySelector<HTMLButtonElement>('[data-action="export-presets"]'),
    importButton: root.querySelector<HTMLButtonElement>('[data-action="import-presets"]'),
    importFileInput: root.querySelector<HTMLInputElement>('[data-action="import-presets-file"]'),
  };
}

export function wirePresetManagerUI<TSettings>(
  els: PresetManagerElements,
  presetStore: PresetStore<TSettings>,
  operationSlug: string,
  onChange: () => void,
): void {
  const { manageButton, closeButton, panel, list, rowTemplate, status, exportButton, importButton, importFileInput } = els;
  if (!manageButton || !panel || !list || !rowTemplate) return;

  function setStatus(message: string): void {
    if (status) status.textContent = message;
  }

  function renderRows(): void {
    list!.innerHTML = "";
    for (const preset of presetStore.list()) {
      const node = rowTemplate!.content.cloneNode(true) as DocumentFragment;
      const row = node.querySelector<HTMLElement>(".batch-preset-manager-row")!;
      row.querySelector<HTMLElement>('[data-cell="name"]')!.textContent = preset.name;

      row.querySelector<HTMLButtonElement>('[data-row-action="rename-preset"]')!.addEventListener("click", () => {
        renamePreset(preset);
      });
      row.querySelector<HTMLButtonElement>('[data-row-action="delete-preset"]')!.addEventListener("click", () => {
        deletePreset(preset);
      });
      list!.appendChild(node);
    }
    if (presetStore.list().length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No saved presets yet.";
      list!.appendChild(empty);
    }
  }

  function renamePreset(preset: StoredPreset<TSettings>): void {
    const nextName = window.prompt("Rename preset:", preset.name);
    if (nextName === null || nextName.trim() === "") return;
    const ok = presetStore.rename(preset.id, nextName.trim());
    if (!ok) {
      setStatus(
        presetStore.list().some((p) => p.name.trim().toLowerCase() === nextName.trim().toLowerCase())
          ? "A preset with that name already exists."
          : "Couldn't rename — your browser storage may be full or restricted.",
      );
      return;
    }
    setStatus(`Renamed to "${nextName.trim()}".`);
    renderRows();
    onChange();
  }

  function deletePreset(preset: StoredPreset<TSettings>): void {
    if (!window.confirm(`Delete preset "${preset.name}"? This can't be undone.`)) return;
    const ok = presetStore.delete(preset.id);
    setStatus(ok ? `Deleted "${preset.name}".` : "Couldn't delete — your browser storage may be full or restricted.");
    renderRows();
    onChange();
  }

  manageButton.addEventListener("click", () => {
    const opening = panel!.hidden;
    panel!.hidden = !opening;
    manageButton.setAttribute("aria-expanded", String(opening));
    if (opening) {
      setStatus("");
      renderRows();
    }
  });

  closeButton?.addEventListener("click", () => {
    panel!.hidden = true;
    manageButton.setAttribute("aria-expanded", "false");
  });

  exportButton?.addEventListener("click", () => {
    const json = presetStore.exportJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `meshkit-${operationSlug}-presets.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${presetStore.list().length} preset(s).`);
  });

  importButton?.addEventListener("click", () => {
    importFileInput?.click();
  });

  importFileInput?.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = "";
    if (!file) return;
    file
      .text()
      .then((text) => {
        try {
          JSON.parse(text);
        } catch {
          setStatus("That file isn't valid preset JSON.");
          return;
        }
        const result = presetStore.importJson(text);
        setStatus(`Imported ${result.imported} preset(s), skipped ${result.skipped}.`);
        renderRows();
        onChange();
      })
      .catch(() => setStatus("Couldn't read that file."));
  });
}
