import { describe, expect, it, vi } from "vitest";
import { ALL_PRO_CAPABILITIES } from "./capabilities";
import { createSnapshot } from "./entitlement-types";
import { FeatureGate, hasCapability } from "./feature-gate";
import { EntitlementStore } from "./entitlement-store";
import { createTestEntitlementProvider } from "./test-provider";

describe("hasCapability — Free denies every Phase 10 capability", () => {
  it.each([...ALL_PRO_CAPABILITIES])("denies %s for a free snapshot", (capability) => {
    const snapshot = createSnapshot("free", [], "test", 1);
    expect(hasCapability(snapshot, capability)).toBe(false);
  });
});

describe("hasCapability — Pro grants only explicitly assigned capabilities", () => {
  it("grants an assigned capability", () => {
    const snapshot = createSnapshot("pro", ["batch-repair"], "test", 1);
    expect(hasCapability(snapshot, "batch-repair")).toBe(true);
  });

  it("denies an unassigned capability even when status is pro", () => {
    const snapshot = createSnapshot("pro", ["batch-repair"], "test", 1);
    expect(hasCapability(snapshot, "batch-optimization")).toBe(false);
  });

  it("a pro snapshot with zero assigned capabilities grants nothing", () => {
    const snapshot = createSnapshot("pro", [], "test", 1);
    for (const capability of ALL_PRO_CAPABILITIES) expect(hasCapability(snapshot, capability)).toBe(false);
  });
});

describe("hasCapability — unknown/invalid/expired/unavailable all fail closed", () => {
  it.each(["unknown", "invalid", "expired", "unavailable"] as const)("denies every capability for status %s", (status) => {
    const snapshot = createSnapshot(status, [], "test", 1);
    for (const capability of ALL_PRO_CAPABILITIES) expect(hasCapability(snapshot, capability)).toBe(false);
  });
});

describe("hasCapability — a missing snapshot/provider fails closed", () => {
  it("denies for undefined", () => {
    expect(hasCapability(undefined, "batch-repair")).toBe(false);
  });
  it("denies for null", () => {
    expect(hasCapability(null, "batch-repair")).toBe(false);
  });
});

describe("FeatureGate — wraps a store, reflects live changes", () => {
  it("can() reflects the store's current snapshot", () => {
    const provider = createTestEntitlementProvider({ status: "pro", capabilities: ["saved-presets"] });
    const store = new EntitlementStore(provider);
    const gate = new FeatureGate(store);
    expect(gate.can("saved-presets")).toBe(true);
    expect(gate.can("batch-repair")).toBe(false);
    provider.dispose();
  });

  it("can() denies everything when the store has no provider (fails closed)", () => {
    const gate = new FeatureGate(new EntitlementStore());
    for (const capability of ALL_PRO_CAPABILITIES) expect(gate.can(capability)).toBe(false);
  });

  it("subscribe() relays live entitlement changes", () => {
    const provider = createTestEntitlementProvider({ status: "free" });
    const store = new EntitlementStore(provider);
    const gate = new FeatureGate(store);
    const listener = vi.fn();
    gate.subscribe(listener);
    provider.setSnapshot({ status: "pro", capabilities: ["batch-conversion"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(gate.can("batch-conversion")).toBe(true);
    provider.dispose();
  });
});
