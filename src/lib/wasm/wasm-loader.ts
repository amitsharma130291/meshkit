import { createSafeError } from "../errors";
import type { WasmLoadOptions, WasmModuleHandle } from "./wasm-types";

/**
 * Caches in-flight/loaded module promises by URL so concurrent or repeated
 * calls for the same module never re-fetch or re-compile it. This is the
 * only mutable module-level state in the loader.
 */
const moduleCache = new Map<string, Promise<WasmModuleHandle>>();

function isWasmSupported(): boolean {
  return typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function";
}

async function fetchAndInstantiate(url: string, options: WasmLoadOptions): Promise<WasmModuleHandle> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw createSafeError("WASM_LOAD_FAILED");
  }
  if (!response.ok) {
    throw createSafeError("WASM_LOAD_FAILED");
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    throw createSafeError("WASM_LOAD_FAILED");
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(buffer);
  } catch {
    throw createSafeError("WASM_COMPILE_FAILED");
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, options.imports ?? {});
  } catch {
    throw createSafeError("WASM_INIT_FAILED");
  }

  return { instance, module, exports: instance.exports };
}

/**
 * Loads and instantiates a local `.wasm` module by URL (same-origin static
 * asset only — never a remote URL). Safe to call repeatedly: the same
 * in-flight or resolved promise is returned for a given URL until
 * `resetWasmCache` clears it, so future tools can call this once per
 * module without coordinating a singleton themselves.
 */
export function loadWasmModule(url: string, options: WasmLoadOptions = {}): Promise<WasmModuleHandle> {
  if (!isWasmSupported()) {
    return Promise.reject(createSafeError("WASM_UNSUPPORTED"));
  }

  const cached = moduleCache.get(url);
  if (cached) return cached;

  const promise = fetchAndInstantiate(url, options).catch((error: unknown) => {
    moduleCache.delete(url); // allow a retry after a transient failure
    throw error;
  });

  moduleCache.set(url, promise);
  return promise;
}

/** Clears one cached module (by URL) or, with no argument, every cached module. */
export function resetWasmCache(url?: string): void {
  if (url) moduleCache.delete(url);
  else moduleCache.clear();
}
