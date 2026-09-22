import { describe, expect, it } from "vitest";
import { millimeterFactorFor, parseThreeMFUnit } from "./units";
import { ThreeMFParseException } from "./errors";

describe("parseThreeMFUnit", () => {
  it("defaults to millimeter when no unit is declared", () => {
    expect(parseThreeMFUnit(undefined)).toBe("millimeter");
  });

  it("accepts every core 3MF unit", () => {
    for (const unit of ["micron", "millimeter", "centimeter", "inch", "foot", "meter"]) {
      expect(parseThreeMFUnit(unit)).toBe(unit);
    }
  });

  it("rejects an unknown unit rather than guessing", () => {
    expect(() => parseThreeMFUnit("furlong")).toThrow(ThreeMFParseException);
    try {
      parseThreeMFUnit("furlong");
    } catch (error) {
      expect((error as ThreeMFParseException).code).toBe("THREEMF_UNIT_UNSUPPORTED");
    }
  });
});

describe("millimeterFactorFor", () => {
  it("converts every unit to millimeters correctly", () => {
    expect(millimeterFactorFor("micron")).toBeCloseTo(0.001, 10);
    expect(millimeterFactorFor("millimeter")).toBe(1);
    expect(millimeterFactorFor("centimeter")).toBe(10);
    expect(millimeterFactorFor("inch")).toBeCloseTo(25.4, 10);
    expect(millimeterFactorFor("foot")).toBeCloseTo(304.8, 10);
    expect(millimeterFactorFor("meter")).toBe(1000);
  });

  it("scales a sample coordinate correctly for every unit", () => {
    const raw = 2;
    expect(raw * millimeterFactorFor("micron")).toBeCloseTo(0.002, 10);
    expect(raw * millimeterFactorFor("millimeter")).toBe(2);
    expect(raw * millimeterFactorFor("centimeter")).toBe(20);
    expect(raw * millimeterFactorFor("inch")).toBeCloseTo(50.8, 10);
    expect(raw * millimeterFactorFor("foot")).toBeCloseTo(609.6, 10);
    expect(raw * millimeterFactorFor("meter")).toBe(2000);
  });
});
