/**
 * Display-only formatting helpers for the STL viewer's info panel. Nothing
 * here touches geometry — these functions only decide how numbers are
 * shown to the user.
 */

/** "units" shows the raw number with no unit claim. mm/cm/in assume the raw numbers are millimeters — a common convention for 3D-printing STLs — and convert for display only. */
export type STLDisplayUnit = "units" | "mm" | "cm" | "in";

const UNIT_FACTORS: Record<STLDisplayUnit, number> = {
  units: 1,
  mm: 1,
  cm: 0.1,
  in: 1 / 25.4,
};

const UNIT_LABELS: Record<STLDisplayUnit, string> = {
  units: "u",
  mm: "mm",
  cm: "cm",
  in: "in",
};

export function convertDimension(rawValue: number, unit: STLDisplayUnit): number {
  return rawValue * UNIT_FACTORS[unit];
}

export function unitLabel(unit: STLDisplayUnit): string {
  return UNIT_LABELS[unit];
}

/** Sensible precision for a raw numeric magnitude: no excessive decimals, scientific notation only at the extremes, safe for exactly zero. */
export function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.001 || abs >= 100000) return value.toExponential(3);
  if (abs < 1) return trimTrailingZeros(value.toFixed(4));
  if (abs < 100) return trimTrailingZeros(value.toFixed(2));
  return trimTrailingZeros(value.toFixed(1));
}

function trimTrailingZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatDimensionWithUnit(rawValue: number, unit: STLDisplayUnit): string {
  return `${formatMagnitude(convertDimension(rawValue, unit))} ${unitLabel(unit)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTriangleCount(count: number): string {
  return count.toLocaleString("en-US");
}
