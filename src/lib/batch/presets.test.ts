import { describe, expect, it } from "vitest";
import { PresetStore } from "./presets";

interface FakeSettings {
  weld: boolean;
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function validate(raw: unknown): FakeSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.weld !== "boolean") return null;
  return { weld: v.weld };
}

function proStore(storage: Storage = fakeStorage()) {
  return new PresetStore<FakeSettings>({ storage, operationKind: "repair", validateSettings: validate, canUsePresets: () => true });
}

describe("PresetStore — create/update/rename/delete", () => {
  it("creates a preset and lists it back", () => {
    const store = proStore();
    const created = store.create("My Preset", { weld: true });
    expect(created).not.toBeNull();
    expect(store.list().map((p) => p.name)).toEqual(["My Preset"]);
  });

  it("updates a preset's settings", () => {
    const store = proStore();
    const created = store.create("My Preset", { weld: true })!;
    expect(store.update(created.id, { weld: false })).toBe(true);
    expect(store.list()[0].settings).toEqual({ weld: false });
  });

  it("renames a preset", () => {
    const store = proStore();
    const created = store.create("Old Name", { weld: true })!;
    expect(store.rename(created.id, "New Name")).toBe(true);
    expect(store.list()[0].name).toBe("New Name");
  });

  it("deletes a preset", () => {
    const store = proStore();
    const created = store.create("My Preset", { weld: true })!;
    expect(store.delete(created.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("update/rename/delete on an unknown id are safe no-ops returning false", () => {
    const store = proStore();
    expect(store.update("nope", { weld: true })).toBe(false);
    expect(store.rename("nope", "x")).toBe(false);
    expect(store.delete("nope")).toBe(false);
  });
});

describe("PresetStore — duplicate and invalid names", () => {
  it("refuses to create a second preset with the same name", () => {
    const store = proStore();
    store.create("My Preset", { weld: true });
    expect(store.create("My Preset", { weld: false })).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("refuses to rename into a name that collides with another preset", () => {
    const store = proStore();
    store.create("A", { weld: true });
    const b = store.create("B", { weld: true })!;
    expect(store.rename(b.id, "A")).toBe(false);
  });

  it("refuses an empty or whitespace-only name", () => {
    const store = proStore();
    expect(store.create("", { weld: true })).toBeNull();
    expect(store.create("   ", { weld: true })).toBeNull();
  });
});

describe("PresetStore — schema validation on create", () => {
  it("refuses settings that fail the injected validator", () => {
    const store = proStore();
    expect(store.create("Bad", { weld: "not-a-boolean" } as unknown as FakeSettings)).toBeNull();
  });
});

describe("PresetStore — corrupted storage / unknown fields / migration", () => {
  it("treats unparsable JSON in storage as empty, never throwing", () => {
    const storage = fakeStorage();
    storage.setItem("meshwrench.pro.presets.v1.repair", "{not valid json");
    const store = proStore(storage);
    expect(() => store.list()).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("silently drops an individual entry that fails validation, keeping the rest", () => {
    const storage = fakeStorage();
    storage.setItem(
      "meshwrench.pro.presets.v1.repair",
      JSON.stringify({
        schemaVersion: 1,
        presets: [
          { id: "a", name: "Good", settings: { weld: true }, createdAt: 1, updatedAt: 1 },
          { id: "b", name: "Bad", settings: { weld: "nope" }, createdAt: 1, updatedAt: 1 },
        ],
      }),
    );
    const store = proStore(storage);
    expect(store.list().map((p) => p.name)).toEqual(["Good"]);
  });

  it("ignores unknown extra fields on a stored preset without crashing", () => {
    const storage = fakeStorage();
    storage.setItem(
      "meshwrench.pro.presets.v1.repair",
      JSON.stringify({
        schemaVersion: 1,
        presets: [{ id: "a", name: "Good", settings: { weld: true }, createdAt: 1, updatedAt: 1, mysteryField: "from the future" }],
      }),
    );
    const store = proStore(storage);
    expect(store.list()).toHaveLength(1);
  });

  it("treats a storage schema version newer than this build understands as unreadable, without crashing or deleting it", () => {
    const storage = fakeStorage();
    const raw = JSON.stringify({ schemaVersion: 999, presets: [{ id: "a", name: "Future", settings: { weld: true } }] });
    storage.setItem("meshwrench.pro.presets.v1.repair", raw);
    const store = proStore(storage);
    expect(store.list()).toEqual([]);
    expect(storage.getItem("meshwrench.pro.presets.v1.repair")).toBe(raw); // left untouched
  });
});

describe("PresetStore — storage quota failure", () => {
  it("create() fails safely when the underlying storage throws on write", () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    const store = proStore(storage);
    expect(store.create("My Preset", { weld: true })).toBeNull();
  });
});

describe("PresetStore — deterministic serialization", () => {
  it("writes the same JSON string for the same preset content", () => {
    const storageA = fakeStorage();
    const storeA = proStore(storageA);
    storeA.create("My Preset", { weld: true });

    const storageB = fakeStorage();
    const storeB = proStore(storageB);
    storeB.create("My Preset", { weld: true });

    const rawA = JSON.parse(storageA.getItem("meshwrench.pro.presets.v1.repair")!);
    const rawB = JSON.parse(storageB.getItem("meshwrench.pro.presets.v1.repair")!);
    expect(rawA.presets[0].name).toBe(rawB.presets[0].name);
    expect(rawA.presets[0].settings).toEqual(rawB.presets[0].settings);
  });
});

describe("PresetStore — import/export JSON", () => {
  it("round-trips presets through exportJson/importJson", () => {
    const storeA = proStore();
    storeA.create("A", { weld: true });
    storeA.create("B", { weld: false });
    const json = storeA.exportJson();

    const storeB = proStore();
    const result = storeB.importJson(json);
    expect(result.imported).toBe(2);
    expect(storeB.list().map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  it("sanitizes imported settings through the real validator, skipping invalid entries", () => {
    const store = proStore();
    const json = JSON.stringify({
      schemaVersion: 1,
      presets: [
        { id: "x", name: "Good", settings: { weld: true }, createdAt: 1, updatedAt: 1 },
        { id: "y", name: "Bad", settings: { weld: "nope" }, createdAt: 1, updatedAt: 1 },
      ],
    });
    const result = store.importJson(json);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(store.list().map((p) => p.name)).toEqual(["Good"]);
  });

  it("skips an imported name that collides with an existing preset", () => {
    const store = proStore();
    store.create("A", { weld: true });
    const json = JSON.stringify({ schemaVersion: 1, presets: [{ id: "z", name: "A", settings: { weld: false }, createdAt: 1, updatedAt: 1 }] });
    const result = store.importJson(json);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe("PresetStore — disposal", () => {
  it("after dispose(), every operation is a safe no-op", () => {
    const store = proStore();
    store.create("A", { weld: true });
    store.dispose();
    expect(store.create("B", { weld: true })).toBeNull();
    expect(store.list()).toEqual([]);
  });
});

describe("PresetStore — Free-tier denial / Pro capability requirement", () => {
  it("every write operation is refused when canUsePresets() returns false", () => {
    const storage = fakeStorage();
    const store = new PresetStore<FakeSettings>({ storage, operationKind: "repair", validateSettings: validate, canUsePresets: () => false });
    expect(store.create("A", { weld: true })).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("a preset saved while Pro is still readable/listable if capability is later revoked (read never gated, only writes)", () => {
    const storage = fakeStorage();
    let canUse = true;
    const store = new PresetStore<FakeSettings>({ storage, operationKind: "repair", validateSettings: validate, canUsePresets: () => canUse });
    store.create("A", { weld: true });
    canUse = false;
    expect(store.list()).toHaveLength(1);
    expect(store.create("B", { weld: true })).toBeNull();
  });
});
