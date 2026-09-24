/**
 * Interprets G0/G1 linear motion against the current modal state.
 * Composes `modal-state.ts`'s own reducer first (so a bare F word, or any
 * coincidental non-motion word on the same line, is handled by that one
 * shared implementation) and then resolves X/Y/Z/E using the — possibly
 * just-updated — positioning modes and unit mode. An omitted axis never
 * moves, in either positioning mode: absolute mode leaves it at its
 * current value, relative mode adds a zero delta.
 *
 * Classification precedence (documented, total, mutually exclusive):
 *   1. no spatial movement (X/Y/Z all unchanged):
 *        E delta 0   -> zero-length-state-update
 *        E delta > 0 -> e-only-extrusion
 *        E delta < 0 -> e-only-retract
 *   2. spatial movement, but only on Z (X/Y unchanged), E delta 0 -> z-only
 *   3. X or Y moved, E delta 0 -> travel
 *   4. any remaining spatial movement with E delta > 0 -> extrusion
 *   5. any remaining spatial movement with E delta < 0 -> retract
 * "prime/unretract" is a statistics-layer relabeling of an
 * e-only-extrusion move that immediately follows a retraction — that
 * requires sequence context this per-move classifier doesn't have, so it
 * is deliberately not a distinct category here.
 */
import { applyModalCommand, type ModalState } from "./modal-state";
import type { TokenizedLine, GCodeWord } from "./tokenizer";

export type MoveCategory = "extrusion" | "travel" | "retract" | "e-only-extrusion" | "e-only-retract" | "z-only" | "zero-length-state-update";

export interface LinearMove {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  eStart: number;
  eEnd: number;
  eDelta: number;
  feedRate: number | null;
  category: MoveCategory;
  rapid: boolean;
  tool: number;
  volumetric: boolean;
  /** The active tool's own target nozzle temperature at the time of this move — never bed temperature — `null` until a valid M104/M109 has been seen for that tool. */
  temperature: number | null;
}

export interface LinearMoveResult {
  state: ModalState;
  move: LinearMove;
}

function paramValue(words: GCodeWord[], letter: string): number | null {
  const w = words.find((word) => word.letter === letter);
  return w && w.finite ? w.value : null;
}

const INCH_TO_MM = 25.4;

function toMillimeters(value: number, unitMode: ModalState["unitMode"]): number {
  return unitMode === "inch" ? value * INCH_TO_MM : value;
}

function resolveAxis(current: number, paramMm: number | null, mode: ModalState["axisPositioning"]): number {
  if (paramMm === null) return current;
  return mode === "absolute" ? paramMm : current + paramMm;
}

function classify(xyMoved: boolean, zMoved: boolean, eDelta: number): MoveCategory {
  const anySpatialMoved = xyMoved || zMoved;

  if (!anySpatialMoved) {
    if (eDelta === 0) return "zero-length-state-update";
    return eDelta > 0 ? "e-only-extrusion" : "e-only-retract";
  }
  if (!xyMoved && zMoved && eDelta === 0) return "z-only";
  if (eDelta === 0) return "travel";
  return eDelta > 0 ? "extrusion" : "retract";
}

export function applyLinearMove(state: ModalState, g: 0 | 1, token: TokenizedLine): LinearMoveResult {
  const afterModal = applyModalCommand(state, token);
  const words = token.words;

  const xParam = paramValue(words, "X");
  const yParam = paramValue(words, "Y");
  const zParam = paramValue(words, "Z");
  const eParam = paramValue(words, "E");

  const xMm = xParam === null ? null : toMillimeters(xParam, afterModal.unitMode);
  const yMm = yParam === null ? null : toMillimeters(yParam, afterModal.unitMode);
  const zMm = zParam === null ? null : toMillimeters(zParam, afterModal.unitMode);
  const eMm = eParam === null ? null : toMillimeters(eParam, afterModal.unitMode);

  const start = { ...afterModal.position };
  const endX = resolveAxis(start.x, xMm, afterModal.axisPositioning);
  const endY = resolveAxis(start.y, yMm, afterModal.axisPositioning);
  const endZ = resolveAxis(start.z, zMm, afterModal.axisPositioning);
  const end = { x: endX, y: endY, z: endZ };

  const eStart = afterModal.toolEPosition[afterModal.activeTool] ?? 0;
  const eEnd = eMm === null ? eStart : afterModal.extruderPositioning === "absolute" ? eMm : eStart + eMm;
  const eDelta = eEnd - eStart;

  const xyMoved = endX !== start.x || endY !== start.y;
  const zMoved = endZ !== start.z;
  const category = classify(xyMoved, zMoved, eDelta);

  const newState: ModalState = {
    ...afterModal,
    position: end,
    toolEPosition: { ...afterModal.toolEPosition, [afterModal.activeTool]: eEnd },
  };

  return {
    state: newState,
    move: {
      start,
      end,
      eStart,
      eEnd,
      eDelta,
      feedRate: newState.feedRate,
      category,
      rapid: g === 0,
      tool: afterModal.activeTool,
      volumetric: afterModal.volumetric,
      temperature: afterModal.toolTemperatureSetpoints[afterModal.activeTool] ?? null,
    },
  };
}
