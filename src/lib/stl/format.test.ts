import { describe, expect, it } from "vitest";
import {
  convertDimension,
  formatDimensionWithUnit,
  formatFileSize,
  formatMagnitude,
  formatTriangleCount,
  unitLabel,
} from "./format";

describe("formatMagnitude", () => {
  it("handles exactly zero without producing '-0' or similar", () => {
    expect(formatMagnitude(0)).toBe("0");
    expect(formatMagnitude(-0)).toBe("0");
  });

  it("uses a few decimal places for sub-1 values", () => {
    expect(formatMagnitude(0.12345)).toBe("0.1235");
  });

  it("trims trailing zeros", () => {
    expect(formatMagnitude(2.5)).toBe("2.5");
    expect(formatMagnitude(10)).toBe("10");
  });

  it("falls back to scientific notation for very small non-zero magnitudes", () => {
    expect(formatMagnitude(0.00001)).toMatch(/e-/);
  });

  it("falls back to scientific notation for very large magnitudes", () => {
    expect(formatMagnitude(1_500_000)).toMatch(/e\+/);
  });

  it("returns an em dash for non-finite input rather than throwing", () => {
    expect(formatMagnitude(Number.NaN)).toBe("—");
    expect(formatMagnitude(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("convertDimension / unitLabel", () => {
  it("treats 'units' and 'mm' identically (the assumed baseline)", () => {
    expect(convertDimension(50, "units")).toBe(50);
    expect(convertDimension(50, "mm")).toBe(50);
  });

  it("converts mm to cm and inches correctly", () => {
    expect(convertDimension(100, "cm")).toBeCloseTo(10, 6);
    expect(convertDimension(25.4, "in")).toBeCloseTo(1, 6);
  });

  it("labels each unit correctly", () => {
    expect(unitLabel("units")).toBe("u");
    expect(unitLabel("mm")).toBe("mm");
    expect(unitLabel("cm")).toBe("cm");
    expect(unitLabel("in")).toBe("in");
  });
});

describe("formatDimensionWithUnit", () => {
  it("combines conversion and formatting with the right label", () => {
    expect(formatDimensionWithUnit(50, "units")).toBe("50 u");
    expect(formatDimensionWithUnit(100, "cm")).toBe("10 cm");
  });
});

describe("formatFileSize", () => {
  it("formats bytes, kilobytes and megabytes appropriately", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatTriangleCount", () => {
  it("adds thousands separators", () => {
    expect(formatTriangleCount(1234567)).toBe("1,234,567");
    expect(formatTriangleCount(42)).toBe("42");
  });
});
