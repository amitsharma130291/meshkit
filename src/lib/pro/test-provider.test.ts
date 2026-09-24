import { describe, expect, it, vi } from "vitest";
import { createTestEntitlementProvider } from "./test-provider";

describe("createTestEntitlementProvider — explicit non-production injection", () => {
  it("defaults to free with zero capabilities when constructed with no argument", () => {
    const provider = createTestEntitlementProvider();
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).toBe("free");
    expect(snapshot.capabilities.size).toBe(0);
    expect(snapshot.source).toBe("test");
    provider.dispose();
  });

  it("accepts an initial status and explicit capability list", () => {
    const provider = createTestEntitlementProvider({ status: "pro", capabilities: ["batch-repair", "saved-presets"] });
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).toBe("pro");
    expect([...snapshot.capabilities].sort()).toEqual(["batch-repair", "saved-presets"]);
    provider.dispose();
  });

  it("setSnapshot() updates synchronously and notifies subscribers", () => {
    const provider = createTestEntitlementProvider();
    const listener = vi.fn();
    provider.subscribe(listener);
    provider.setSnapshot({ status: "pro", capabilities: ["batch-conversion"] });
    expect(provider.getSnapshot().status).toBe("pro");
    expect(listener).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("setSnapshotAsync() resolves after the given delay and only the latest call wins", async () => {
    vi.useFakeTimers();
    try {
      const provider = createTestEntitlementProvider();
      const pending1 = provider.setSnapshotAsync({ status: "pro", capabilities: ["batch-repair"] }, 100);
      const pending2 = provider.setSnapshotAsync({ status: "pro", capabilities: ["saved-presets"] }, 10);
      await vi.advanceTimersByTimeAsync(150);
      await pending1;
      await pending2;
      expect(provider.getSnapshot().status).toBe("pro");
      expect([...provider.getSnapshot().capabilities]).toEqual(["saved-presets"]);
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces empty capabilities for a non-pro status, same fail-closed guarantee as production", () => {
    const provider = createTestEntitlementProvider({ status: "expired", capabilities: ["batch-repair"] });
    expect(provider.getSnapshot().capabilities.size).toBe(0);
    provider.dispose();
  });
});
