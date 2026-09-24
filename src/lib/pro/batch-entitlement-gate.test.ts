import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `batch-entitlement-gate.ts` is DOM-heavy (`document.querySelector`,
 * `window.addEventListener`) and, per this project's own established
 * convention, isn't unit-tested with a fake DOM — its interactive
 * behavior is verified live in a real browser. What IS fully testable
 * here, and is exactly what item 1 requires, is that its SOURCE
 * contains no query-string/URL-fragment/storage/global entitlement
 * bypass at all — the previous `?devPro=1` mechanism this file once
 * had is removed entirely, in favor of explicit constructor injection
 * (`initBatchEntitlementGate(..., entitlementProvider)`).
 */
function readSource(): string {
  const raw = readFileSync(new URL("./batch-entitlement-gate.ts", import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("batch-entitlement-gate.ts — no URL/storage/global entitlement bypass (source-level guarantee)", () => {
  const source = readSource();
  const forbidden = [
    "location.search",
    "URLSearchParams",
    "location.hash",
    "localStorage",
    "sessionStorage",
    "window[",
    "globalThis[",
    "devPro",
    "test-provider",
    "createTestEntitlementProvider",
  ];

  it.each(forbidden)("never references %s", (token) => {
    expect(source.includes(token)).toBe(false);
  });
});

describe("batch-entitlement-gate.ts — takes its EntitlementProvider as an explicit dependency", () => {
  const source = readSource();

  it("initBatchEntitlementGate's own signature accepts an entitlementProvider parameter", () => {
    expect(source).toMatch(/function\s+initBatchEntitlementGate\s*\([^)]*entitlementProvider[^)]*\)/);
  });

  it("never constructs its own provider internally — no production-provider import beyond passing it through", () => {
    // The gate must not import createProductionEntitlementProvider itself —
    // that decision belongs to the caller (a page's own _client.ts, or a
    // test harness), never to this shared module.
    expect(source).not.toMatch(/createProductionEntitlementProvider/);
  });
});

describe("every production page _client.ts imports no test provider and constructs the production provider explicitly", () => {
  const pagesToCheck = ["3mf-to-stl", "glb-to-stl", "obj-to-stl", "ply-to-stl", "stl-to-obj", "stl-to-3mf"];

  it.each(pagesToCheck)("%s/_client.ts imports createProductionEntitlementProvider and never test-provider", (page) => {
    const path = new URL(`../../pages/${page}/_client.ts`, import.meta.url);
    const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).toContain("createProductionEntitlementProvider");
    expect(source).not.toContain("test-provider");
    expect(source).not.toContain("devPro");
  });
});
