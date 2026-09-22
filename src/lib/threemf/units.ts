import { threeMFError } from "./errors";
import type { ThreeMFUnit } from "./types";

/** Factor to multiply a coordinate by to convert it to millimeters. */
const UNIT_TO_MM: Record<ThreeMFUnit, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const KNOWN_UNITS: ReadonlySet<string> = new Set(Object.keys(UNIT_TO_MM));

export function millimeterFactorFor(unit: ThreeMFUnit): number {
  return UNIT_TO_MM[unit];
}

/** Parses the <model unit="..."> attribute. Rejects (rather than guesses at) anything not in the 3MF core spec's unit list. */
export function parseThreeMFUnit(value: string | undefined): ThreeMFUnit {
  if (value === undefined) {
    return "millimeter"; // the 3MF core spec's default when no unit is declared
  }
  if (!KNOWN_UNITS.has(value)) {
    throw threeMFError("THREEMF_UNIT_UNSUPPORTED");
  }
  return value as ThreeMFUnit;
}
