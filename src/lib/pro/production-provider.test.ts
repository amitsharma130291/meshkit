import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProductionEntitlementProvider } from "./production-provider";

describe("createProductionEntitlementProvider — always free, until Phase 11", () => {
  it("resolves to free with zero capabilities", () => {
    const provider = createProductionEntitlementProvider();
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).toBe("free");
    expect(snapshot.capabilities.size).toBe(0);
    expect(snapshot.source).toBe("production-default");
    provider.dispose();
  });

  it("never resolves to pro no matter how many times it's constructed", () => {
    for (let i = 0; i < 5; i++) {
      const provider = createProductionEntitlementProvider();
      expect(provider.getSnapshot().status).toBe("free");
      provider.dispose();
    }
  });

  it("still resolves free even after subscribing (no delayed unlock)", () => {
    const provider = createProductionEntitlementProvider();
    let latest = provider.getSnapshot();
    provider.subscribe((snapshot) => (latest = snapshot));
    expect(latest.status).toBe("free");
    provider.dispose();
  });
});

describe("createProductionEntitlementProvider — no bypass mechanisms (source-level guarantee)", () => {
  const rawSource = readFileSync(new URL("./production-provider.ts", import.meta.url), "utf8");
  // Strip comments first so prose explaining WHY these are forbidden
  // (which necessarily names them) doesn't trip the check meant for CODE.
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
    "localStorage",
    "sessionStorage",
    "location.search",
    "URLSearchParams",
    "location.hash",
    "window[",
    "globalThis[",
    "test-provider",
  ];

  it.each(forbidden)("never references %s", (token) => {
    expect(source.includes(token)).toBe(false);
  });
});
