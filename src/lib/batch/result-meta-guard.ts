/**
 * Defense-in-depth for every batch job's `resultMeta` before it reaches
 * a downloadable JSON report or a ZIP's `reports/*.json`/
 * `batch-summary.json` entries — Stage 4 of the Phase 10 hotfix.
 *
 * This does NOT replace explicit per-adapter projection
 * (`conversion-result-meta.ts`'s `project*Meta()` functions, or repair/
 * optimize's own already-bounded `unwrap*Result()` functions in
 * `adapter-registry.ts`) — it's a second, independent layer that keeps
 * working even if a future adapter change reintroduces an unsafe field,
 * since it inspects the actual VALUE shape rather than trusting that
 * whoever built `resultMeta` got every field right.
 *
 * Never throws. A value that fails validation is replaced with a small,
 * fixed-shape, genuinely safe placeholder — one file's bad metadata
 * degrades gracefully rather than crashing the whole batch report or
 * ZIP download with an uncaught `RangeError`.
 */

/** Generous relative to `MAX_CONVERSION_RESULT_META_BYTES` (a real conversion summary is ~2KB) — this is the hard defense-in-depth ceiling, not the expected size. */
export const MAX_RESULT_META_SERIALIZED_BYTES = 32 * 1024;
export const MAX_RESULT_META_STRING_LENGTH = 4096;
export const MAX_RESULT_META_ARRAY_LENGTH = 512;
export const MAX_RESULT_META_DEPTH = 6;

export interface ResultMetaValidation {
  ok: boolean;
  reason?: string;
}

export interface ResultMetaGuardOptions {
  /** When supplied, every top-level key of the value must be in this set — anything else fails validation. Nested object keys (e.g. inside `bounds`) are not restricted by this list, only checked structurally. */
  allowedKeys?: ReadonlySet<string>;
}

function isForbiddenBinaryValue(value: unknown): boolean {
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true; // every TypedArray variant + DataView
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof File !== "undefined" && value instanceof File) return true;
  return false;
}

function validateValue(value: unknown, depth: number, seen: Set<object>): ResultMetaValidation {
  if (value === null) return { ok: true };
  const type = typeof value;

  if (type === "boolean") return { ok: true };
  if (type === "number") {
    if (!Number.isFinite(value as number)) return { ok: false, reason: "non-finite number (NaN or Infinity)" };
    return { ok: true };
  }
  if (type === "string") {
    if ((value as string).length > MAX_RESULT_META_STRING_LENGTH) return { ok: false, reason: "string exceeds the maximum allowed length" };
    return { ok: true };
  }
  if (type === "bigint") return { ok: false, reason: "BigInt is not JSON-safe" };
  if (type === "undefined") return { ok: true }; // JSON.stringify silently drops undefined-valued keys — never a crash risk
  if (type === "function" || type === "symbol") return { ok: false, reason: `${type} is not JSON-safe` };

  if (isForbiddenBinaryValue(value)) return { ok: false, reason: "binary buffer, typed array, Blob or File is forbidden in report metadata" };

  if (type === "object") {
    const obj = value as object;
    if (seen.has(obj)) return { ok: false, reason: "circular reference" };
    if (depth > MAX_RESULT_META_DEPTH) return { ok: false, reason: "exceeds the maximum nesting depth" };

    seen.add(obj);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_RESULT_META_ARRAY_LENGTH) return { ok: false, reason: "array exceeds the maximum allowed length" };
        for (const item of value) {
          const result = validateValue(item, depth + 1, seen);
          if (!result.ok) return result;
        }
        return { ok: true };
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return { ok: false, reason: "non-plain object is not JSON-safe" };

      for (const key of Object.keys(obj)) {
        const result = validateValue((obj as Record<string, unknown>)[key], depth + 1, seen);
        if (!result.ok) return result;
      }
      return { ok: true };
    } finally {
      seen.delete(obj);
    }
  }

  return { ok: false, reason: `unsupported value type: ${type}` };
}

/**
 * Structural + size validation. Runs a full walk before the serialized-
 * size check so a specific, actionable reason (e.g. "typed array") is
 * reported instead of always blaming size once the walk itself would
 * have failed anyway.
 */
export function validateResultMeta(value: unknown, options: ResultMetaGuardOptions = {}): ResultMetaValidation {
  if (value === undefined || value === null) return { ok: true };

  if (options.allowedKeys && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!options.allowedKeys.has(key)) return { ok: false, reason: `unexpected key "${key}" is not in the allowed metadata set` };
    }
  }

  const structural = validateValue(value, 0, new Set());
  if (!structural.ok) return structural;

  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { ok: false, reason: "value could not be serialized" };
  }
  if (serialized.length > MAX_RESULT_META_SERIALIZED_BYTES) {
    return { ok: false, reason: "serialized metadata exceeds the maximum allowed size" };
  }
  return { ok: true };
}

/**
 * Never throws. Returns the original value when it passes validation,
 * or a tiny, fixed-shape, safe placeholder object otherwise — the
 * placeholder is itself guaranteed JSON-safe and well under the size
 * ceiling, so a report/ZIP containing it can never itself trigger the
 * `RangeError` this guard exists to prevent.
 */
export function sanitizeResultMetaForReport(value: unknown, options: ResultMetaGuardOptions = {}): unknown {
  const validation = validateResultMeta(value, options);
  if (validation.ok) return value;
  return { resultMetaOmitted: true, reason: "This file's result metadata did not pass the report-safety check and was omitted." };
}
