import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWasmModule, resetWasmCache } from "./wasm-loader";

const fixturePath = path.resolve(process.cwd(), "public/wasm/foundation.wasm");

beforeEach(() => {
  resetWasmCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadWasmModule", () => {
  it("loads, compiles and instantiates the foundation fixture", async () => {
    const bytes = await readFile(fixturePath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );

    const handle = await loadWasmModule("/wasm/foundation.wasm");
    const add = handle.exports.add as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("caches the in-flight promise so a URL is only fetched once", async () => {
    const bytes = await readFile(fixturePath);
    const fetchMock = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetchMock);

    const first = loadWasmModule("/wasm/foundation.wasm");
    const second = loadWasmModule("/wasm/foundation.wasm");
    expect(second).toBe(first);

    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a failed fetch to WASM_LOAD_FAILED and allows a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(loadWasmModule("/wasm/missing.wasm")).rejects.toMatchObject({ code: "WASM_LOAD_FAILED" });

    // A failed load must not be cached — a retry should fetch again.
    const bytes = await readFile(fixturePath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const handle = await loadWasmModule("/wasm/missing.wasm");
    expect(handle.exports.add).toBeTypeOf("function");
  });
});
