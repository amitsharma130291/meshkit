/**
 * Formats a `Float32Array`-sourced coordinate as decimal text, preserving
 * enough precision that re-parsing the text and rounding to float32 again
 * reproduces the exact original float32 value. Canonical, format-neutral
 * home for this logic — moved here from `src/lib/obj/` (where it
 * originated during the OBJ writer's Phase 3D implementation) once the
 * 3MF writer (Phase 3E) needed the identical guarantee for the same
 * `Float32Array` geometry. `src/lib/obj/number-format.ts` now re-exports
 * a thin, behavior-preserving wrapper around this module — see that
 * file's comment for why a wrapper (rather than a bare re-export) was
 * necessary.
 */
import { NonFiniteCoordinateError } from "./errors";

/**
 * IEEE-754 float32 has at most ~7.2 decimal digits of precision; 9
 * significant digits is the smallest fixed digit count that's always
 * sufficient to round-trip any float32 back to its exact bit pattern
 * (the standard "shortest round-trippable decimal" bound for binary32).
 */
const MAX_SIGNIFICANT_DIGITS = 9;

/**
 * Formats `value` (assumed to already be a float32-precision number, as
 * everything read out of a `Float32Array` is) using the fewest
 * significant digits that still round-trip exactly through
 * `Math.fround`. Normalizes `-0` to `"0"`. Throws `NonFiniteCoordinateError`
 * for `NaN`/`Infinity` — every parser upstream of this function already
 * rejects non-finite geometry on input, so reaching this branch means
 * something later in a pipeline manufactured a bad value; it should
 * never happen, but the text that would otherwise produce invalid XML/OBJ
 * output is defended against here too.
 */
export function formatFloat32(value: number): string {
  if (!Number.isFinite(value)) {
    throw new NonFiniteCoordinateError();
  }
  if (value === 0) {
    // Catches both +0 and -0 (`-0 === 0` is true) — deliberately
    // normalized so the sign of a zero coordinate never leaks into output.
    return "0";
  }

  const target = Math.fround(value);
  for (let precision = 1; precision <= MAX_SIGNIFICANT_DIGITS; precision++) {
    const candidate = target.toPrecision(precision);
    if (Math.fround(Number(candidate)) === target) {
      return trimNumericString(candidate);
    }
  }
  // Unreachable in practice (9 significant digits always round-trips a
  // float32), but falls back to the full-precision form rather than
  // throwing, so a pathological platform float rounding difference can
  // never turn into a hard failure for otherwise-valid geometry.
  return trimNumericString(target.toPrecision(MAX_SIGNIFICANT_DIGITS));
}

/** Strips trailing zeros (and a then-dangling decimal point) from the mantissa only — never touches an exponent suffix. */
function trimNumericString(text: string): string {
  const exponentIndex = text.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? "" : text.slice(exponentIndex);
  const trimmedMantissa = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
  return trimmedMantissa + exponent;
}
