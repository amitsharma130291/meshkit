import { describe, expect, it } from "vitest";
import { MAX_RESULT_META_SERIALIZED_BYTES, sanitizeResultMetaForReport, validateResultMeta } from "./result-meta-guard";

describe("validateResultMeta — Stage 4 defense-in-depth structural checks", () => {
  it("accepts valid, bounded, JSON-safe metadata", () => {
    const meta = { triangleCount: 10, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, warnings: [{ code: "x", message: "y" }] };
    expect(validateResultMeta(meta)).toEqual({ ok: true });
  });

  it("accepts undefined (no metadata at all is fine)", () => {
    expect(validateResultMeta(undefined)).toEqual({ ok: true });
  });

  it("accepts null", () => {
    expect(validateResultMeta(null)).toEqual({ ok: true });
  });

  it("rejects an unexpected key when an allowlist is supplied", () => {
    const result = validateResultMeta({ triangleCount: 10, secretInternal: "nope" }, { allowedKeys: new Set(["triangleCount"]) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/key/i);
  });

  it("accepts every key when it's in the supplied allowlist", () => {
    const result = validateResultMeta({ a: 1, b: 2 }, { allowedKeys: new Set(["a", "b"]) });
    expect(result.ok).toBe(true);
  });

  it("rejects a typed array anywhere in the value", () => {
    const result = validateResultMeta({ positions: new Float32Array([1, 2, 3]) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/typed array|binary/i);
  });

  it("rejects a raw ArrayBuffer", () => {
    const result = validateResultMeta({ buffer: new ArrayBuffer(8) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/arraybuffer|binary/i);
  });

  it("rejects a DataView", () => {
    const result = validateResultMeta({ view: new DataView(new ArrayBuffer(8)) });
    expect(result.ok).toBe(false);
  });

  it("rejects a Blob", () => {
    const result = validateResultMeta({ blob: new Blob(["x"]) });
    expect(result.ok).toBe(false);
  });

  it("rejects a File", () => {
    const result = validateResultMeta({ file: new File(["x"], "a.txt") });
    expect(result.ok).toBe(false);
  });

  it("rejects a deeply nested structure beyond the max depth", () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const result = validateResultMeta(deep);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/depth|nest/i);
  });

  it("rejects a circular reference instead of infinite-looping", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const result = validateResultMeta(circular);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/circular/i);
  });

  it("rejects an excessively long string", () => {
    const result = validateResultMeta({ note: "x".repeat(1_000_000) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/string|length/i);
  });

  it("rejects metadata whose total serialized size exceeds the documented maximum", () => {
    // Many small, individually-valid fields that together exceed the bound.
    const bloated: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) bloated[`field${i}`] = "0123456789012345678901234567890123456789";
    const result = validateResultMeta(bloated);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/size|length/i);
    expect(JSON.stringify(bloated).length).toBeGreaterThan(MAX_RESULT_META_SERIALIZED_BYTES);
  });

  it("rejects NaN", () => {
    const result = validateResultMeta({ value: NaN });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/finite|nan/i);
  });

  it("rejects Infinity", () => {
    const result = validateResultMeta({ value: Infinity });
    expect(result.ok).toBe(false);
  });

  it("rejects -Infinity", () => {
    const result = validateResultMeta({ value: -Infinity });
    expect(result.ok).toBe(false);
  });

  it("rejects BigInt", () => {
    const result = validateResultMeta({ value: 10n });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bigint/i);
  });

  it("rejects a function value", () => {
    const result = validateResultMeta({ value: () => 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-plain-object (class instance) value", () => {
    class Weird {
      x = 1;
    }
    const result = validateResultMeta({ value: new Weird() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/object/i);
  });

  it("rejects an oversized array", () => {
    const result = validateResultMeta({ list: new Array(100_000).fill(1) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/array|length/i);
  });
});

describe("sanitizeResultMetaForReport — never throws, always returns something JSON.stringify-safe", () => {
  it("returns the original metadata unchanged when it's already valid", () => {
    const meta = { triangleCount: 10 };
    expect(sanitizeResultMetaForReport(meta)).toEqual(meta);
  });

  it("returns a small, safe placeholder instead of the raw value when metadata is unsafe — never throws", () => {
    const unsafe = { positions: new Float32Array(1_000_000) };
    let thrown = false;
    let sanitized: unknown;
    try {
      sanitized = sanitizeResultMetaForReport(unsafe);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
    expect(JSON.stringify(sanitized).length).toBeLessThan(500);
  });

  it("the placeholder never contains the raw unsafe value or any fragment of it", () => {
    const unsafe = { secret: new Float32Array([1, 2, 3]) };
    const sanitized = sanitizeResultMetaForReport(unsafe) as Record<string, unknown>;
    expect(JSON.stringify(sanitized)).not.toContain("secret");
  });

  it("handles a genuinely huge synthetic result (the original crash reproduction) without throwing RangeError", () => {
    const huge = { positions: new Float32Array(6_000_000), normals: new Float32Array(6_000_000) };
    expect(() => {
      const sanitized = sanitizeResultMetaForReport(huge);
      JSON.stringify(sanitized);
    }).not.toThrow();
  });

  it("applies the supplied allowedKeys, dropping to the safe placeholder when an unexpected key is present", () => {
    const meta = { triangleCount: 10, somethingUnexpected: "value" };
    const sanitized = sanitizeResultMetaForReport(meta, { allowedKeys: new Set(["triangleCount"]) });
    expect(sanitized).not.toEqual(meta);
    expect(JSON.stringify(sanitized)).not.toContain("somethingUnexpected");
  });
});
