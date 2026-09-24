/**
 * 3MF embedded-color resolution: hex parsing, sRGB→linear conversion, and
 * resolving a (pid, pindex) property reference against the resource maps
 * `viewer-resources.ts` collects. Kept separate from scene-walking
 * (viewer-scene.ts) so color-interpretation rules can be tested in
 * isolation from transform/hierarchy logic.
 *
 * Malformed hex *values* (present but unparseable) are treated the same
 * way the rest of this codebase's 3MF module treats a malformed data
 * value at definition time (e.g. a non-finite vertex coordinate) — a hard
 * `THREEMF_COLOR_REFERENCE_INVALID` parse error. A syntactically valid but
 * *dangling* reference (an unknown pid, or a pindex outside a resolved
 * group) is a much softer problem — the geometry itself is still perfectly
 * valid — so `resolvePropertyColor` reports it as `{ kind: "invalid" }`
 * for the caller to turn into a warning and a neutral-color fallback,
 * never a thrown exception.
 */
import { threeMFError } from "./errors";

export interface ParsedColor {
  /** sRGB channel, 0..1. */
  r: number;
  g: number;
  b: number;
  /** 0..1. Always 1 for a 6-digit (#RRGGBB) value. */
  alpha: number;
}

const HEX6_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX8_PATTERN = /^#[0-9a-fA-F]{8}$/;

/** Parses a 3MF `color`/`displaycolor` attribute value: `#RRGGBB` or `#RRGGBBAA`. Throws for anything else — this is a malformed data VALUE, not a dangling reference. */
export function parseThreeMFColorHex(value: string): ParsedColor {
  if (HEX6_PATTERN.test(value)) {
    return {
      r: hexByte(value, 1) / 255,
      g: hexByte(value, 3) / 255,
      b: hexByte(value, 5) / 255,
      alpha: 1,
    };
  }
  if (HEX8_PATTERN.test(value)) {
    return {
      r: hexByte(value, 1) / 255,
      g: hexByte(value, 3) / 255,
      b: hexByte(value, 5) / 255,
      alpha: hexByte(value, 7) / 255,
    };
  }
  throw threeMFError("THREEMF_COLOR_REFERENCE_INVALID");
}

function hexByte(value: string, offset: number): number {
  return Number.parseInt(value.slice(offset, offset + 2), 16);
}

/** Standard sRGB EOTF — deliberate, documented conversion so raw per-corner color bytes written into a Three.js `BufferAttribute` (which bypasses `THREE.Color`'s own colorspace handling) are linear-space, matching what physically-based lighting expects. */
export function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export interface MaterialEntry {
  name: string | null;
  color: ParsedColor | null;
}

export interface ColorGroupEntry {
  color: ParsedColor;
}

/** Resource maps collected by viewer-resources.ts, keyed by their `<basematerials>`/`<colorgroup>` `id` attribute. */
export interface ThreeMFColorResources {
  basematerials: Map<string, MaterialEntry[]>;
  colorgroups: Map<string, ColorGroupEntry[]>;
  /** pids that resolve to a texture-backed group — valid, but never color-resolved (no image decoding in this phase). */
  textureGroupIds: Set<string>;
}

export type PropertyColorResolution =
  | { kind: "color"; color: ParsedColor; ref: string }
  | { kind: "texture" }
  | { kind: "invalid" }
  | { kind: "none" };

/** Resolves one (pid, pindex) property reference — the same resolution a triangle's own `pid`/`p1`/`p2`/`p3` or an object's default `pid`/`pindex` needs. */
export function resolvePropertyColor(
  resources: ThreeMFColorResources,
  pid: string | undefined,
  pindex: number | undefined,
): PropertyColorResolution {
  if (pid === undefined || pindex === undefined) return { kind: "none" };
  if (resources.textureGroupIds.has(pid)) return { kind: "texture" };

  const materials = resources.basematerials.get(pid);
  if (materials) {
    const entry = materials[pindex];
    if (!entry || !entry.color) return { kind: "invalid" };
    return { kind: "color", color: entry.color, ref: `Material ${pid}:${pindex}` };
  }

  const colors = resources.colorgroups.get(pid);
  if (colors) {
    const entry = colors[pindex];
    if (!entry) return { kind: "invalid" };
    return { kind: "color", color: entry.color, ref: `Colors ${pid}:${pindex}` };
  }

  return { kind: "invalid" };
}
