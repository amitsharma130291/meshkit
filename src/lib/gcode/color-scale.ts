/**
 * The G-code Cluster's temperature color mode: a documented cool-to-hot
 * scale (blue at the range minimum, through green/yellow, to red at the
 * range maximum) — the same HSL-gradient shape `_client.ts` already uses
 * for its feed-rate color mode, extracted here so it's independently
 * testable. An unknown (NaN) segment temperature is always neutral gray,
 * never a false color; a value outside the declared range is clamped,
 * never producing an out-of-gamut color. This is a display convention
 * MeshWrench chose, not a standard.
 */
import type { Range } from "./statistics";

const UNKNOWN_TEMPERATURE_COLOR: [number, number, number] = [0.6, 0.6, 0.6];

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Available whenever the file declared at least one valid nozzle setpoint — including a single constant temperature. */
export function isTemperatureModeAvailable(range: Range | null): boolean {
  return range !== null;
}

export function temperatureColor(temperature: number, range: Range): [number, number, number] {
  if (Number.isNaN(temperature)) return UNKNOWN_TEMPERATURE_COLOR;
  const clamped = Math.max(range.min, Math.min(range.max, temperature));
  const t = range.max > range.min ? (clamped - range.min) / (range.max - range.min) : 0.5;
  const hue = 0.6 - t * 0.6; // blue (cool) -> red (hot), same convention as feed-rate coloring
  return hslToRgb(hue, 0.75, 0.5);
}
