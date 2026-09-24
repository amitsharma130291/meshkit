import { describe, expect, it } from "vitest";
import { temperatureColor, isTemperatureModeAvailable } from "./color-scale";

describe("isTemperatureModeAvailable", () => {
  it("is available when a valid nozzle temperature range exists", () => {
    expect(isTemperatureModeAvailable({ min: 200, max: 210 })).toBe(true);
  });

  it("is available for one constant temperature (min === max)", () => {
    expect(isTemperatureModeAvailable({ min: 200, max: 200 })).toBe(true);
  });

  it("is never available when no nozzle temperature was ever declared", () => {
    expect(isTemperatureModeAvailable(null)).toBe(false);
  });
});

describe("temperatureColor — documented cool-to-hot scale", () => {
  it("returns a neutral gray for an unknown (NaN) temperature, never a false color", () => {
    const color = temperatureColor(NaN, { min: 200, max: 210 });
    expect(color).toEqual([0.6, 0.6, 0.6]);
  });

  it("returns the coolest color at the range minimum", () => {
    const min = temperatureColor(200, { min: 200, max: 210 });
    const max = temperatureColor(210, { min: 200, max: 210 });
    expect(min).not.toEqual(max);
  });

  it("handles a single constant temperature (min === max) without dividing by zero", () => {
    expect(() => temperatureColor(200, { min: 200, max: 200 })).not.toThrow();
    const color = temperatureColor(200, { min: 200, max: 200 });
    expect(color.every((c) => Number.isFinite(c))).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const range = { min: 190, max: 220 };
    expect(temperatureColor(205, range)).toEqual(temperatureColor(205, range));
  });

  it("clamps a temperature outside the declared range rather than producing an out-of-gamut color", () => {
    const range = { min: 200, max: 210 };
    const below = temperatureColor(150, range);
    const atMin = temperatureColor(200, range);
    expect(below).toEqual(atMin);
  });
});
