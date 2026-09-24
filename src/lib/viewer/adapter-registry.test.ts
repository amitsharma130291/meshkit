/**
 * Exhaustiveness and lazy-loading verification for `ADAPTER_LOADERS`.
 * Each loader is a genuine dynamic `import()`, resolved here the same
 * way `/viewer/`'s own client does — proving both "every format maps to
 * the right adapter" and "loading one format's adapter module never
 * requires touching `Worker`/`document`/WebGL globals this Node test
 * environment doesn't have" (a real `new Worker(...)` call only happens
 * inside `createWorker()`'s own function body, never at module load
 * time — see each adapter file's own top-level code for why importing
 * it is safe here).
 */
import { describe, expect, it } from "vitest";
import { ADAPTER_LOADERS } from "./adapter-registry";
import type { DetectedFormat } from "./format-detection";

const ALL_FORMATS: DetectedFormat[] = ["stl", "obj", "3mf", "glb", "ply", "fbx"];

describe("ADAPTER_LOADERS", () => {
  it("is exhaustive: exactly the six supported formats, no more, no fewer", () => {
    expect(Object.keys(ADAPTER_LOADERS).sort()).toEqual([...ALL_FORMATS].sort());
  });

  for (const format of ALL_FORMATS) {
    it(`lazily loads the correct adapter for "${format}"`, async () => {
      const mod = await ADAPTER_LOADERS[format]();
      expect(mod.default.format).toBe(format);
      expect(mod.default.label.length).toBeGreaterThan(0);
      expect(mod.default.extensions.length).toBeGreaterThan(0);
      expect(typeof mod.default.createWorker).toBe("function");
      expect(typeof mod.default.buildScene).toBe("function");
      expect(typeof mod.default.disposeScene).toBe("function");
    });
  }

  it("each adapter's own declared extensions include its own format id (or a documented alias, e.g. GLB/glTF)", async () => {
    for (const format of ALL_FORMATS) {
      const mod = await ADAPTER_LOADERS[format]();
      const matchesOwnFormat = mod.default.extensions.some((ext) => ext === format || (format === "glb" && ext === "gltf"));
      expect(matchesOwnFormat).toBe(true);
    }
  });
});
