/**
 * Reads the handful of `GlobalSettings` → `Properties70` entries this
 * viewer's unit/axis normalization actually needs. Per this phase's own
 * "avoid guessing" policy: a missing or self-contradictory value here
 * doesn't get a silent default — see `resolve-scene.ts` for how a `null`
 * result from this module turns into "keep the file's raw coordinates,
 * show a warning" rather than an invented unit or axis order.
 */
import { readProperties70 } from "./document";
import type { FBXNode, FBXProperty } from "./types";

export type FBXAxisIndex = 0 | 1 | 2;
export type FBXAxisSign = 1 | -1;

export interface FBXAxisSystem {
  upAxis: FBXAxisIndex;
  upSign: FBXAxisSign;
  frontAxis: FBXAxisIndex;
  frontSign: FBXAxisSign;
  coordAxis: FBXAxisIndex;
  coordSign: FBXAxisSign;
}

export interface FBXGlobalSettingsResult {
  /** Centimeters represented by one scene unit — FBX SDK's own `FbxSystemUnit` convention (e.g. 100 for meters, 1 for centimeters). `null` when the file doesn't declare a usable value. */
  unitScaleFactor: number | null;
  /** `null` when the file doesn't declare a complete, self-consistent axis system (all three axes present, forming a permutation of X/Y/Z, each sign exactly ±1). */
  axisSystem: FBXAxisSystem | null;
}

function readNumeric(prop: FBXProperty | undefined): number | null {
  if (!prop) return null;
  if (prop.type === "I" || prop.type === "F" || prop.type === "D" || prop.type === "Y") return prop.value;
  return null;
}

function readInt(props: Map<string, FBXProperty[]>, name: string): number | null {
  const value = readNumeric(props.get(name)?.[0]);
  if (value === null || !Number.isInteger(value)) return null;
  return value;
}

function readAxisIndex(value: number | null): FBXAxisIndex | null {
  return value === 0 || value === 1 || value === 2 ? value : null;
}

function readAxisSign(value: number | null): FBXAxisSign | null {
  return value === 1 || value === -1 ? value : null;
}

function readAxisSystem(props: Map<string, FBXProperty[]>): FBXAxisSystem | null {
  const upAxis = readAxisIndex(readInt(props, "UpAxis"));
  const upSign = readAxisSign(readInt(props, "UpAxisSign"));
  const frontAxis = readAxisIndex(readInt(props, "FrontAxis"));
  const frontSign = readAxisSign(readInt(props, "FrontAxisSign"));
  const coordAxis = readAxisIndex(readInt(props, "CoordAxis"));
  const coordSign = readAxisSign(readInt(props, "CoordAxisSign"));

  if (upAxis === null || upSign === null || frontAxis === null || frontSign === null || coordAxis === null || coordSign === null) {
    return null;
  }
  // A valid axis system uses each of X/Y/Z exactly once — two axes claiming
  // the same slot is exactly the "contradictory" case this phase's own
  // spec calls out; falling back to raw coordinates is safer than guessing
  // which one is right.
  const distinct = new Set([upAxis, frontAxis, coordAxis]);
  if (distinct.size !== 3) return null;

  return { upAxis, upSign, frontAxis, frontSign, coordAxis, coordSign };
}

function readUnitScaleFactor(props: Map<string, FBXProperty[]>): number | null {
  const value = readNumeric(props.get("UnitScaleFactor")?.[0]);
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function parseGlobalSettings(node: FBXNode | null): FBXGlobalSettingsResult {
  if (!node) return { unitScaleFactor: null, axisSystem: null };
  const props = readProperties70(node);
  return {
    unitScaleFactor: readUnitScaleFactor(props),
    axisSystem: readAxisSystem(props),
  };
}
