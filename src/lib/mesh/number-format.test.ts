import { describe, expect, it } from "vitest";
import { formatFloat32 } from "./number-format";
import { NonFiniteCoordinateError } from "./errors";

function roundTrips(value: number): boolean {
  const formatted = formatFloat32(value);
  return Math.fround(Number(formatted)) === Math.fround(value);
}

describe("formatFloat32 (canonical, format-neutral)", () => {
  it("formats zero as '0'", () => {
    expect(formatFloat32(0)).toBe("0");
  });

  it("normalizes negative zero to '0'", () => {
    expect(formatFloat32(-0)).toBe("0");
  });

  it("formats a positive integer without a decimal point", () => {
    expect(formatFloat32(42)).toBe("42");
  });

  it("formats a negative integer", () => {
    expect(formatFloat32(-17)).toBe("-17");
  });

  it("formats a simple fraction with trailing zeros trimmed", () => {
    expect(formatFloat32(1.5)).toBe("1.5");
    expect(formatFloat32(0.25)).toBe("0.25");
  });

  it("round-trips a value that needs all nine significant digits", () => {
    expect(roundTrips(Math.fround(123.456789))).toBe(true);
  });

  it("round-trips a small scientific-notation-range value", () => {
    expect(roundTrips(Math.fround(1.2345e-8))).toBe(true);
  });

  it("round-trips a large scientific-notation-range value", () => {
    expect(roundTrips(Math.fround(3.4e38))).toBe(true);
  });

  it("round-trips a broad sample of representative float32 values", () => {
    const samples = [0.1, 1 / 3, Math.PI, 100000.5, 0.0001, -123.456, 999999.9, 1e-30, 1e30, 7, -7];
    for (const raw of samples) expect(roundTrips(Math.fround(raw))).toBe(true);
  });

  it("throws the generic, format-agnostic NonFiniteCoordinateError for NaN and Infinity", () => {
    expect(() => formatFloat32(Number.NaN)).toThrow(NonFiniteCoordinateError);
    expect(() => formatFloat32(Number.POSITIVE_INFINITY)).toThrow(NonFiniteCoordinateError);
    expect(() => formatFloat32(Number.NEGATIVE_INFINITY)).toThrow(NonFiniteCoordinateError);
  });

  it("produces deterministic output across repeated calls", () => {
    const value = Math.fround(12345.6789);
    expect(formatFloat32(value)).toBe(formatFloat32(value));
  });
});
