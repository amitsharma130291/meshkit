/**
 * Local, reusable presets for STL Repair and STL Optimization. Lives
 * entirely on-device in `localStorage` under a namespaced, versioned
 * key per operation (`meshwrench.pro.presets.v1.<operationKind>`) —
 * never the entitlement state itself and never source/output file bytes.
 *
 * Every WRITE (create/update/rename/delete/import) is refused when
 * `canUsePresets()` is false — presets are a Pro capability
 * (`saved-presets`). Reading an already-saved preset is never gated,
 * so a preset a user saved earlier doesn't appear to vanish; only the
 * ability to add or change one requires the capability.
 *
 * Imported settings are sanitized through the SAME `validateSettings`
 * function real preset creation uses — imported JSON is exactly as
 * untrusted as anything else arriving from outside this module.
 */
const CURRENT_SCHEMA_VERSION = 1;
const KEY_PREFIX = "meshwrench.pro.presets.v1";

export interface StoredPreset<TSettings> {
  readonly id: string;
  name: string;
  settings: TSettings;
  readonly createdAt: number;
  updatedAt: number;
}

interface StoredFile<TSettings> {
  schemaVersion: number;
  presets: StoredPreset<TSettings>[];
}

export interface PresetStoreOptions<TSettings> {
  storage: Storage;
  operationKind: "repair" | "optimize";
  /** The SAME schema validator preset creation and preset import both go through — an untrusted settings object either comes back as a well-formed `TSettings` or is rejected entirely, never partially trusted. */
  validateSettings: (raw: unknown) => TSettings | null;
  canUsePresets: () => boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let idSequence = 0;
function nextPresetId(): string {
  idSequence += 1;
  return `preset-${Date.now().toString(36)}-${idSequence}`;
}

export class PresetStore<TSettings> {
  private readonly storage: Storage;
  private readonly key: string;
  private readonly validateSettings: (raw: unknown) => TSettings | null;
  private readonly canUsePresets: () => boolean;
  private disposed = false;

  constructor(options: PresetStoreOptions<TSettings>) {
    this.storage = options.storage;
    this.key = `${KEY_PREFIX}.${options.operationKind}`;
    this.validateSettings = options.validateSettings;
    this.canUsePresets = options.canUsePresets;
  }

  private readFile(): StoredFile<TSettings> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return { schemaVersion: CURRENT_SCHEMA_VERSION, presets: [] };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { schemaVersion: CURRENT_SCHEMA_VERSION, presets: [] };
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.presets)) return { schemaVersion: CURRENT_SCHEMA_VERSION, presets: [] };

    const schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      // A future format this build doesn't understand — never delete or
      // guess at it; just treat it as unreadable for now.
      return { schemaVersion: CURRENT_SCHEMA_VERSION, presets: [] };
    }

    const presets: StoredPreset<TSettings>[] = [];
    for (const entry of parsed.presets) {
      if (!isPlainRecord(entry)) continue;
      if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      const settings = this.validateSettings(entry.settings);
      if (settings === null) continue;
      presets.push({
        id: entry.id,
        name: entry.name,
        settings,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      });
    }
    return { schemaVersion: CURRENT_SCHEMA_VERSION, presets };
  }

  private writeFile(file: StoredFile<TSettings>): boolean {
    try {
      this.storage.setItem(this.key, JSON.stringify(file));
      return true;
    } catch {
      return false;
    }
  }

  list(): readonly StoredPreset<TSettings>[] {
    if (this.disposed) return [];
    return this.readFile().presets;
  }

  private nameTaken(name: string, presets: readonly StoredPreset<TSettings>[], excludeId?: string): boolean {
    const normalized = name.trim().toLowerCase();
    return presets.some((p) => p.id !== excludeId && p.name.trim().toLowerCase() === normalized);
  }

  create(name: string, settings: TSettings): StoredPreset<TSettings> | null {
    if (this.disposed || !this.canUsePresets()) return null;
    if (name.trim() === "") return null;
    const validated = this.validateSettings(settings as unknown);
    if (validated === null) return null;

    const file = this.readFile();
    if (this.nameTaken(name, file.presets)) return null;

    const now = Date.now();
    const preset: StoredPreset<TSettings> = { id: nextPresetId(), name, settings: validated, createdAt: now, updatedAt: now };
    file.presets.push(preset);
    if (!this.writeFile(file)) return null;
    return preset;
  }

  update(id: string, settings: TSettings): boolean {
    if (this.disposed || !this.canUsePresets()) return false;
    const validated = this.validateSettings(settings as unknown);
    if (validated === null) return false;

    const file = this.readFile();
    const preset = file.presets.find((p) => p.id === id);
    if (!preset) return false;
    preset.settings = validated;
    preset.updatedAt = Date.now();
    return this.writeFile(file);
  }

  rename(id: string, newName: string): boolean {
    if (this.disposed || !this.canUsePresets()) return false;
    if (newName.trim() === "") return false;

    const file = this.readFile();
    const preset = file.presets.find((p) => p.id === id);
    if (!preset) return false;
    if (this.nameTaken(newName, file.presets, id)) return false;
    preset.name = newName;
    preset.updatedAt = Date.now();
    return this.writeFile(file);
  }

  delete(id: string): boolean {
    if (this.disposed || !this.canUsePresets()) return false;
    const file = this.readFile();
    const before = file.presets.length;
    file.presets = file.presets.filter((p) => p.id !== id);
    if (file.presets.length === before) return false;
    return this.writeFile(file);
  }

  exportJson(): string {
    return JSON.stringify(this.readFile());
  }

  importJson(json: string): { imported: number; skipped: number } {
    if (this.disposed || !this.canUsePresets()) return { imported: 0, skipped: 0 };

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { imported: 0, skipped: 0 };
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.presets)) return { imported: 0, skipped: 0 };

    const file = this.readFile();
    let imported = 0;
    let skipped = 0;

    for (const entry of parsed.presets) {
      if (!isPlainRecord(entry) || typeof entry.name !== "string") {
        skipped++;
        continue;
      }
      const settings = this.validateSettings(entry.settings);
      if (settings === null || this.nameTaken(entry.name, file.presets)) {
        skipped++;
        continue;
      }
      const now = Date.now();
      file.presets.push({ id: nextPresetId(), name: entry.name, settings, createdAt: now, updatedAt: now });
      imported++;
    }

    if (imported > 0) this.writeFile(file);
    return { imported, skipped };
  }

  dispose(): void {
    this.disposed = true;
  }
}
