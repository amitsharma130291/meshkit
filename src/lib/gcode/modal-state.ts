/**
 * Explicit G-code modal state and its reducer for non-motion commands
 * (G20/G21, G90/G91, M82/M83, G92, G17/G18/G19, Tn, temperatures, fan,
 * speed/flow factors, volumetric mode, feed rate). Motion commands
 * (G0/G1/G2/G3) are interpreted by `linear-moves.ts`/`arcs.ts`, which
 * READ this same state shape and update `position`/`toolEPosition`
 * themselves — kept separate so each stays independently testable.
 *
 * Documented G90/G91 vs. M82/M83 policy (MeshWrench's own, not a universal
 * firmware guarantee): axis positioning (G90/G91) and extruder
 * positioning (M82/M83) are tracked as fully INDEPENDENT modes. G90/G91
 * never implicitly changes extruder positioning. This matches every
 * slicer in this project's supported dialect scope (Cura, PrusaSlicer,
 * OrcaSlicer, Bambu Studio all emit M82/M83 independently of G90/G91,
 * which is exactly why those separate commands exist) — it does not
 * claim to match every historical bare Marlin configuration.
 */
import type { GCodeWord, TokenizedLine } from "./tokenizer";

export type UnitMode = "mm" | "inch";
export type AxisPositioningMode = "absolute" | "relative";
export type ExtruderPositioningMode = "absolute" | "relative";
export type WorkspacePlane = "XY" | "XZ" | "YZ";

export interface ModalState {
  position: { x: number; y: number; z: number };
  unitMode: UnitMode;
  /** True once G20/G21 has appeared at least once — otherwise `unitMode` is the documented ASSUMED default, not a file-declared fact. */
  unitsExplicit: boolean;
  axisPositioning: AxisPositioningMode;
  extruderPositioning: ExtruderPositioningMode;
  workspacePlane: WorkspacePlane;
  activeTool: number;
  /** Each tool's own E position, tracked independently — switching tools never resets or shares another tool's extrusion state. */
  toolEPosition: Record<number, number>;
  /** mm/min. `null` until the first F word (on any line) is seen. */
  feedRate: number | null;
  bedTemperatureSetpoint: number | null;
  toolTemperatureSetpoints: Record<number, number | null>;
  /** Raw M106 S value (0-255); 0 means off (including after M107). */
  fanSpeed: number;
  /** M220 percentage, default 100. */
  speedFactor: number;
  /** M221 percentage, default 100. */
  flowFactor: number;
  /** Set by M200: a positive D enables volumetric extrusion, D0 disables it. */
  volumetric: boolean;
}

const INCH_TO_MM = 25.4;

function toMillimeters(value: number, unitMode: UnitMode): number {
  return unitMode === "inch" ? value * INCH_TO_MM : value;
}

export function createInitialModalState(): ModalState {
  return {
    position: { x: 0, y: 0, z: 0 },
    unitMode: "mm",
    unitsExplicit: false,
    axisPositioning: "absolute",
    extruderPositioning: "absolute",
    workspacePlane: "XY",
    activeTool: 0,
    toolEPosition: { 0: 0 },
    feedRate: null,
    bedTemperatureSetpoint: null,
    toolTemperatureSetpoints: {},
    fanSpeed: 0,
    speedFactor: 100,
    flowFactor: 100,
    volumetric: false,
  };
}

function findWord(words: GCodeWord[], letter: string): GCodeWord | undefined {
  return words.find((w) => w.letter === letter);
}

function paramValue(words: GCodeWord[], letter: string): number | null {
  const w = findWord(words, letter);
  return w && w.finite ? w.value : null;
}

function applyG92(state: ModalState, words: GCodeWord[]): ModalState {
  const x = paramValue(words, "X");
  const y = paramValue(words, "Y");
  const z = paramValue(words, "Z");
  const e = paramValue(words, "E");
  if (x === null && y === null && z === null && e === null) return state;

  const position = { ...state.position };
  if (x !== null) position.x = toMillimeters(x, state.unitMode);
  if (y !== null) position.y = toMillimeters(y, state.unitMode);
  if (z !== null) position.z = toMillimeters(z, state.unitMode);

  let toolEPosition = state.toolEPosition;
  if (e !== null) {
    toolEPosition = { ...toolEPosition, [state.activeTool]: toMillimeters(e, state.unitMode) };
  }

  return { ...state, position, toolEPosition };
}

function applyGCommand(state: ModalState, g: number, words: GCodeWord[]): ModalState {
  switch (g) {
    case 20:
      return { ...state, unitMode: "inch", unitsExplicit: true };
    case 21:
      return { ...state, unitMode: "mm", unitsExplicit: true };
    case 90:
      return { ...state, axisPositioning: "absolute" };
    case 91:
      return { ...state, axisPositioning: "relative" };
    case 17:
      return { ...state, workspacePlane: "XY" };
    case 18:
      return { ...state, workspacePlane: "XZ" };
    case 19:
      return { ...state, workspacePlane: "YZ" };
    case 92:
      return applyG92(state, words);
    default:
      return state;
  }
}

function applyMCommand(state: ModalState, m: number, words: GCodeWord[]): ModalState {
  switch (m) {
    case 82:
      return { ...state, extruderPositioning: "absolute" };
    case 83:
      return { ...state, extruderPositioning: "relative" };
    case 104:
    case 109: {
      const s = paramValue(words, "S");
      if (s === null) return state;
      return { ...state, toolTemperatureSetpoints: { ...state.toolTemperatureSetpoints, [state.activeTool]: s } };
    }
    case 140:
    case 190: {
      const s = paramValue(words, "S");
      if (s === null) return state;
      return { ...state, bedTemperatureSetpoint: s };
    }
    case 106: {
      const s = paramValue(words, "S");
      return { ...state, fanSpeed: s ?? 255 };
    }
    case 107:
      return { ...state, fanSpeed: 0 };
    case 220: {
      const s = paramValue(words, "S");
      if (s === null) return state;
      return { ...state, speedFactor: s };
    }
    case 221: {
      const s = paramValue(words, "S");
      if (s === null) return state;
      return { ...state, flowFactor: s };
    }
    case 200: {
      const d = paramValue(words, "D");
      if (d === null) return state;
      return { ...state, volumetric: d > 0 };
    }
    default:
      return state;
  }
}

function applyToolChange(state: ModalState, word: GCodeWord): ModalState {
  const toolNumber = word.value !== null && word.finite ? Math.trunc(word.value) : 0;
  const toolEPosition = toolNumber in state.toolEPosition ? state.toolEPosition : { ...state.toolEPosition, [toolNumber]: 0 };
  return { ...state, activeTool: toolNumber, toolEPosition };
}

export function applyModalCommand(state: ModalState, token: TokenizedLine): ModalState {
  let next = state;

  for (const word of token.words) {
    if (word.letter === "G" && word.value !== null && word.finite) {
      next = applyGCommand(next, Math.trunc(word.value), token.words);
    } else if (word.letter === "M" && word.value !== null && word.finite) {
      next = applyMCommand(next, Math.trunc(word.value), token.words);
    } else if (word.letter === "T") {
      next = applyToolChange(next, word);
    }
  }

  const f = paramValue(token.words, "F");
  if (f !== null) {
    next = { ...next, feedRate: toMillimeters(f, next.unitMode) };
  }

  return next;
}
