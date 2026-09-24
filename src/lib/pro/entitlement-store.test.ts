import { describe, expect, it, vi } from "vitest";
import { EntitlementStore } from "./entitlement-store";
import { createTestEntitlementProvider } from "./test-provider";

describe("EntitlementStore — missing provider fails closed", () => {
  it("getSnapshot() is unavailable/zero-capability when constructed with no provider", () => {
    const store = new EntitlementStore();
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.capabilities.size).toBe(0);
  });
});

describe("EntitlementStore — relays a provider's snapshot", () => {
  it("reflects the provider's current snapshot once set", () => {
    const provider = createTestEntitlementProvider({ status: "pro", capabilities: ["batch-repair"] });
    const store = new EntitlementStore(provider);
    expect(store.getSnapshot().status).toBe("pro");
    provider.dispose();
  });

  it("notifies store subscribers when the underlying provider changes", () => {
    const provider = createTestEntitlementProvider();
    const store = new EntitlementStore(provider);
    const listener = vi.fn();
    store.subscribe(listener);
    provider.setSnapshot({ status: "pro", capabilities: ["saved-presets"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe("pro");
    provider.dispose();
  });

  it("setProvider swaps the active provider and immediately reflects its snapshot", () => {
    const providerA = createTestEntitlementProvider({ status: "free" });
    const providerB = createTestEntitlementProvider({ status: "pro", capabilities: ["batch-optimization"] });
    const store = new EntitlementStore(providerA);
    store.setProvider(providerB);
    expect(store.getSnapshot().status).toBe("pro");
    providerA.dispose();
    providerB.dispose();
  });

  it("stops relaying the OLD provider's changes after setProvider swaps to a new one", () => {
    const providerA = createTestEntitlementProvider({ status: "free" });
    const providerB = createTestEntitlementProvider({ status: "free" });
    const store = new EntitlementStore(providerA);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setProvider(providerB);
    listener.mockClear();
    providerA.setSnapshot({ status: "pro", capabilities: ["batch-repair"] });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe("free");
    providerA.dispose();
    providerB.dispose();
  });
});

describe("EntitlementStore — disposal", () => {
  it("disposed store subscribers receive no further events", () => {
    const provider = createTestEntitlementProvider();
    const store = new EntitlementStore(provider);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    provider.setSnapshot({ status: "pro", capabilities: [] });
    expect(listener).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("getSnapshot() after dispose falls back to the fail-closed default", () => {
    const provider = createTestEntitlementProvider({ status: "pro", capabilities: ["batch-repair"] });
    const store = new EntitlementStore(provider);
    store.dispose();
    expect(store.getSnapshot().status).toBe("unavailable");
    provider.dispose();
  });

  it("disposing the store does NOT dispose the underlying provider (caller owns provider lifecycle)", () => {
    const provider = createTestEntitlementProvider({ status: "pro", capabilities: ["batch-repair"] });
    const store = new EntitlementStore(provider);
    store.dispose();
    expect(provider.getSnapshot().status).toBe("pro");
    provider.dispose();
  });
});
