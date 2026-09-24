import { describe, expect, it } from "vitest";
import { createSnapshot, FAIL_CLOSED_SNAPSHOT } from "./entitlement-types";

describe("createSnapshot — the single fail-closed choke point", () => {
  it("carries exactly the given capabilities when status is pro", () => {
    const snapshot = createSnapshot("pro", ["batch-repair", "saved-presets"], "test", 123);
    expect(snapshot.status).toBe("pro");
    expect([...snapshot.capabilities].sort()).toEqual(["batch-repair", "saved-presets"]);
    expect(snapshot.source).toBe("test");
    expect(snapshot.checkedAt).toBe(123);
  });

  it.each(["free", "unknown", "invalid", "expired", "unavailable"] as const)(
    "forces an EMPTY capability set for status %s even when capabilities are passed in",
    (status) => {
      const snapshot = createSnapshot(status, ["batch-repair", "saved-presets"], "production-default", 1);
      expect(snapshot.status).toBe(status);
      expect(snapshot.capabilities.size).toBe(0);
    },
  );

  it("returns an immutable capability set", () => {
    const snapshot = createSnapshot("pro", ["batch-repair"], "test", 1);
    expect(() => (snapshot.capabilities as unknown as Set<string>).add("batch-optimization")).toThrow();
  });
});

describe("FAIL_CLOSED_SNAPSHOT — the default when no provider/store exists", () => {
  it("is unavailable with zero capabilities", () => {
    expect(FAIL_CLOSED_SNAPSHOT.status).toBe("unavailable");
    expect(FAIL_CLOSED_SNAPSHOT.capabilities.size).toBe(0);
    expect(FAIL_CLOSED_SNAPSHOT.checkedAt).toBeNull();
  });
});
