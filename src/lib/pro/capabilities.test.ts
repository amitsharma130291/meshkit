import { describe, expect, it } from "vitest";
import { ALL_PRO_CAPABILITIES, freezeCapabilitySet, isProCapability, type ProCapability } from "./capabilities";

describe("ALL_PRO_CAPABILITIES — the exhaustive Phase 10 capability list", () => {
  it("contains exactly the Phase 10 capability keys", () => {
    expect([...ALL_PRO_CAPABILITIES].sort()).toEqual(
      ["ad-free", "batch-conversion", "batch-optimization", "batch-repair", "batch-zip-download", "multi-file-queue", "saved-presets"].sort(),
    );
  });

  it("is itself immutable", () => {
    expect(() => (ALL_PRO_CAPABILITIES as unknown as Set<string>).add("bogus")).toThrow();
  });
});

describe("isProCapability", () => {
  it("accepts every known capability key", () => {
    for (const capability of ALL_PRO_CAPABILITIES) expect(isProCapability(capability)).toBe(true);
  });

  it("rejects an unknown string", () => {
    expect(isProCapability("not-a-real-capability")).toBe(false);
  });
});

describe("freezeCapabilitySet", () => {
  it("produces a set containing exactly the given capabilities", () => {
    const frozen = freezeCapabilitySet(["batch-repair", "saved-presets"]);
    expect([...frozen].sort()).toEqual(["batch-repair", "saved-presets"]);
  });

  it("rejects add/delete/clear at runtime, not just at the type level", () => {
    const frozen = freezeCapabilitySet(["batch-repair"]);
    const mutable = frozen as unknown as Set<string>;
    expect(() => mutable.add("batch-optimization")).toThrow();
    expect(() => mutable.delete("batch-repair")).toThrow();
    expect(() => mutable.clear()).toThrow();
    expect([...frozen]).toEqual(["batch-repair"]);
  });

  it("is not affected by later mutation of the source iterable", () => {
    const source: ProCapability[] = ["batch-repair"];
    const frozen = freezeCapabilitySet(source);
    source.push("batch-optimization");
    expect([...frozen]).toEqual(["batch-repair"]);
  });

  it("deduplicates repeated entries", () => {
    const frozen = freezeCapabilitySet(["batch-repair", "batch-repair"]);
    expect(frozen.size).toBe(1);
  });
});
