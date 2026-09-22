import { describe, expect, it } from "vitest";
import { formatFloat32 } from "./number-format";
import { expectOBJError } from "./test-fixtures";

function roundTrips(value: number): boolean {
  const formatted = formatFloat32(value);
  return Math.fround(Number(formatted)) === Math.fround(value);
}

describe("formatFloat32", () => {
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
    const value = Math.fround(123.456789);
    expect(roundTrips(value)).toBe(true);
  });

  it("round-trips a small scientific-notation-range value", () => {
    const value = Math.fround(1.2345e-8);
    expect(roundTrips(value)).toBe(true);
  });

  it("round-trips a large scientific-notation-range value", () => {
    const value = Math.fround(3.4e38);
    expect(roundTrips(value)).toBe(true);
  });

  it("round-trips a broad sample of representative float32 values", () => {
    const samples = [0.1, 1 / 3, Math.PI, 100000.5, 0.0001, -123.456, 999999.9, 1e-30, 1e30, 7, -7, 0.001, 2 ** 20 + 0.5];
    for (const raw of samples) {
      expect(roundTrips(Math.fround(raw))).toBe(true);
    }
  });

  it("uses the shortest representation that still round-trips (no needless trailing digits)", () => {
    expect(formatFloat32(Math.fround(2))).toBe("2");
    expect(formatFloat32(Math.fround(0.5))).toBe("0.5");
  });

  it("rejects NaN and Infinity", () => {
    expectOBJError(() => formatFloat32(Number.NaN), "OBJ_NON_FINITE_OUTPUT");
    expectOBJError(() => formatFloat32(Number.POSITIVE_INFINITY), "OBJ_NON_FINITE_OUTPUT");
    expectOBJError(() => formatFloat32(Number.NEGATIVE_INFINITY), "OBJ_NON_FINITE_OUTPUT");
  });

  it("produces deterministic output across repeated calls", () => {
    const value = Math.fround(12345.6789);
    expect(formatFloat32(value)).toBe(formatFloat32(value));
  });
});
