import { describe, expect, it, vi } from "vitest";
import { createEntitlementProvider } from "./entitlement-provider";
import { createSnapshot, FAIL_CLOSED_SNAPSHOT } from "./entitlement-types";

describe("createEntitlementProvider — getSnapshot", () => {
  it("returns the initial snapshot before any resolution", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    expect(provider.getSnapshot()).toEqual(FAIL_CLOSED_SNAPSHOT);
  });
});

describe("createEntitlementProvider — subscribe/notify", () => {
  it("notifies a subscriber with the new snapshot after resolve()", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const listener = vi.fn();
    provider.subscribe(listener);
    const next = createSnapshot("pro", ["batch-repair"], "test", 1);
    provider.resolve(next);
    expect(listener).toHaveBeenCalledWith(next);
    expect(provider.getSnapshot()).toEqual(next);
  });

  it("notifies every subscriber, not just the first", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const a = vi.fn();
    const b = vi.fn();
    provider.subscribe(a);
    provider.subscribe(b);
    const next = createSnapshot("pro", [], "test", 1);
    provider.resolve(next);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after the subscriber calls its own unsubscribe function", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);
    unsubscribe();
    provider.resolve(createSnapshot("pro", [], "test", 1));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createEntitlementProvider — dispose", () => {
  it("stops notifying previously-subscribed listeners after dispose", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const listener = vi.fn();
    provider.subscribe(listener);
    provider.dispose();
    provider.resolve(createSnapshot("pro", [], "test", 1));
    expect(listener).not.toHaveBeenCalled();
  });

  it("a subscribe() call made after dispose is a safe no-op that never fires", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    provider.dispose();
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);
    provider.resolve(createSnapshot("pro", [], "test", 1));
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("calling dispose twice is a safe no-op", () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    provider.dispose();
    expect(() => provider.dispose()).not.toThrow();
  });
});

describe("createEntitlementProvider — resolveAsync ignores stale results", () => {
  it("applies only the most recently REQUESTED async resolution, even if an older one settles later", async () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const listener = vi.fn();
    provider.subscribe(listener);

    let resolveFirst!: (s: ReturnType<typeof createSnapshot>) => void;
    const first = new Promise<ReturnType<typeof createSnapshot>>((resolve) => (resolveFirst = resolve));
    provider.resolveAsync(first);

    const second = Promise.resolve(createSnapshot("pro", ["saved-presets"], "test", 2));
    provider.resolveAsync(second);
    await second;
    await Promise.resolve(); // let the microtask queue settle

    // The first (stale) request finally settles AFTER the second already applied.
    resolveFirst(createSnapshot("pro", ["batch-repair"], "test", 1));
    await Promise.resolve();
    await Promise.resolve();

    expect(provider.getSnapshot().status).toBe("pro");
    expect([...provider.getSnapshot().capabilities]).toEqual(["saved-presets"]);
    const staleCalls = listener.mock.calls.filter(([snapshot]) => [...snapshot.capabilities].includes("batch-repair"));
    expect(staleCalls).toEqual([]);
  });

  it("a resolveAsync that settles after dispose never notifies and never updates the snapshot", async () => {
    const provider = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
    const listener = vi.fn();
    provider.subscribe(listener);
    const pending = Promise.resolve(createSnapshot("pro", [], "test", 1));
    provider.resolveAsync(pending);
    provider.dispose();
    await pending;
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
