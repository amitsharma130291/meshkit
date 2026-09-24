/**
 * G2/G3 arc motion. Resolves the arc's center/radius/sweep from either
 * the I/J/K center-offset form or the R radius form, then converts the
 * arc into a bounded set of straight render segments using a documented
 * chord-error policy — never fewer than a safety-floor segment count for
 * a real curve, and never more than `maxSegmentsPerArc` (a genuinely
 * invalid arc is reported as an error with ZERO segments; it is never
 * silently drawn as a single straight line, which would misrepresent the
 * file's own geometry).
 *
 * I/J/K are ALWAYS incremental offsets from the start point to the arc's
 * center, in the CURRENT unit mode — this is a fixed G-code convention,
 * independent of G90/G91 (which only govern X/Y/Z/E endpoint
 * interpretation, never I/J/K).
 *
 * R-form center selection reuses the standard, widely-implemented grbl
 * `mc_arc` formula: for a given direction, a positive R selects the
 * center that sweeps <=180°; a negative R selects the center that sweeps
 * >180°. A chord longer than the diameter (`2*|R|`) is an impossible
 * radius; a zero-length chord (endpoint equals start) has no unique
 * center in R form at all and is reported as `missing-center` (a full
 * circle can only be expressed in I/J/K form, which has an explicit,
 * unambiguous center).
 */
import { CancellationRequested } from "../cancellation";
import { applyModalCommand, type ModalState, type WorkspacePlane } from "./modal-state";
import type { GCodeWord, TokenizedLine } from "./tokenizer";

export interface ArcSafetyLimits {
  /** Maximum allowed sagitta (perpendicular deviation) between the true arc and its rendered chord, in mm. */
  maxChordError: number;
  maxSegmentsPerArc: number;
  minSegments: number;
}

export const DEFAULT_ARC_LIMITS: ArcSafetyLimits = {
  maxChordError: 0.02,
  maxSegmentsPerArc: 1000,
  minSegments: 3,
};

export type ArcErrorReason = "impossible-radius" | "missing-center" | "inconsistent-radius" | "non-finite";

export interface ArcSegment {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  eStart: number;
  eEnd: number;
}

interface ArcMoveOk {
  ok: true;
  state: ModalState;
  /** The arc's center in PLANE coordinates (`a`/`b` — the two axes of the active workspace plane, e.g. X/Y for G17), never a fixed X/Y regardless of plane. */
  center: { a: number; b: number };
  radius: number;
  sweepRadians: number;
  clockwise: boolean;
  segments: ArcSegment[];
  eStart: number;
  eEnd: number;
  eDelta: number;
  feedRate: number | null;
  subdivisionCeilingHit: boolean;
  /** The active tool's own target nozzle temperature in effect for this arc — never bed temperature — `null` until a valid M104/M109 has been seen for that tool. */
  temperature: number | null;
}

interface ArcMoveError {
  ok: false;
  state: ModalState;
  reason: ArcErrorReason;
  segments: ArcSegment[];
  eStart: number;
  eEnd: number;
  eDelta: number;
  feedRate: number | null;
  subdivisionCeilingHit: boolean;
  temperature: number | null;
}

export type ArcMoveResult = ArcMoveOk | ArcMoveError;

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

interface PlaneAxes {
  aLetter: "X" | "Y" | "Z";
  bLetter: "X" | "Y" | "Z";
  helicalLetter: "X" | "Y" | "Z";
  offsetALetter: "I" | "J" | "K";
  offsetBLetter: "I" | "J" | "K";
}

function planeAxes(plane: WorkspacePlane): PlaneAxes {
  if (plane === "XY") return { aLetter: "X", bLetter: "Y", helicalLetter: "Z", offsetALetter: "I", offsetBLetter: "J" };
  if (plane === "XZ") return { aLetter: "X", bLetter: "Z", helicalLetter: "Y", offsetALetter: "I", offsetBLetter: "K" };
  return { aLetter: "Y", bLetter: "Z", helicalLetter: "X", offsetALetter: "J", offsetBLetter: "K" };
}

function normalizeSweep(delta: number): number {
  let d = delta % (2 * Math.PI);
  if (d <= 0) d += 2 * Math.PI;
  return d;
}

const RADIUS_TOLERANCE_RATIO = 1e-4;

function resolveCenterAndSweep(
  start: { a: number; b: number },
  end: { a: number; b: number },
  offsetA: number | null,
  offsetB: number | null,
  radiusParam: number | null,
  clockwise: boolean,
): { center: { a: number; b: number }; radius: number; sweep: number } | { error: ArcErrorReason } {
  const isFullCircle = start.a === end.a && start.b === end.b;

  if (offsetA !== null || offsetB !== null) {
    const center = { a: start.a + (offsetA ?? 0), b: start.b + (offsetB ?? 0) };
    const radiusFromStart = Math.hypot(start.a - center.a, start.b - center.b);
    const radiusFromEnd = Math.hypot(end.a - center.a, end.b - center.b);
    if (radiusFromStart === 0) return { error: "impossible-radius" };
    if (!isFullCircle && Math.abs(radiusFromEnd - radiusFromStart) > radiusFromStart * RADIUS_TOLERANCE_RATIO) {
      return { error: "inconsistent-radius" };
    }
    const startAngle = Math.atan2(start.b - center.b, start.a - center.a);
    const endAngle = isFullCircle ? startAngle : Math.atan2(end.b - center.b, end.a - center.a);
    const sweep = isFullCircle ? 2 * Math.PI : normalizeSweep(clockwise ? startAngle - endAngle : endAngle - startAngle);
    return { center, radius: radiusFromStart, sweep };
  }

  if (radiusParam !== null) {
    if (isFullCircle) return { error: "missing-center" };
    const x = end.a - start.a;
    const y = end.b - start.b;
    const d = Math.hypot(x, y);
    if (d === 0) return { error: "missing-center" };
    const r = radiusParam;
    const hx2divd = 4 * r * r - x * x - y * y;
    if (hx2divd < 0) return { error: "impossible-radius" };
    let h = -Math.sqrt(hx2divd) / d;
    if (clockwise === r < 0) h = -h;
    const centerOffsetA = 0.5 * (x - y * h);
    const centerOffsetB = 0.5 * (y + x * h);
    const center = { a: start.a + centerOffsetA, b: start.b + centerOffsetB };
    const radius = Math.abs(r);
    const startAngle = Math.atan2(start.b - center.b, start.a - center.a);
    const endAngle = Math.atan2(end.b - center.b, end.a - center.a);
    const sweep = normalizeSweep(clockwise ? startAngle - endAngle : endAngle - startAngle);
    return { center, radius, sweep };
  }

  return { error: "missing-center" };
}

function segmentCountFor(radius: number, sweep: number, limits: ArcSafetyLimits): { count: number; ceilingHit: boolean } {
  const safeRadius = Math.max(radius, 1e-9);
  const ratio = Math.max(0, 1 - limits.maxChordError / safeRadius);
  const maxAnglePerSegment = 2 * Math.acos(Math.min(1, ratio));
  const idealCount = maxAnglePerSegment > 0 ? Math.ceil(sweep / maxAnglePerSegment) : limits.maxSegmentsPerArc;
  const bounded = Math.min(Math.max(idealCount, limits.minSegments), limits.maxSegmentsPerArc);
  return { count: bounded, ceilingHit: idealCount > limits.maxSegmentsPerArc };
}

const CANCELLATION_CHECK_INTERVAL = 64;

export function applyArcMove(
  state: ModalState,
  g: 2 | 3,
  token: TokenizedLine,
  limits: ArcSafetyLimits = DEFAULT_ARC_LIMITS,
  options: { isCancelled?: () => boolean } = {},
): ArcMoveResult {
  const afterModal = applyModalCommand(state, token);
  const words = token.words;
  const clockwise = g === 2;
  const axes = planeAxes(afterModal.workspacePlane);

  const xParam = paramValue(words, "X");
  const yParam = paramValue(words, "Y");
  const zParam = paramValue(words, "Z");
  const eParam = paramValue(words, "E");
  const iParam = paramValue(words, "I");
  const jParam = paramValue(words, "J");
  const kParam = paramValue(words, "K");
  const rParam = paramValue(words, "R");

  const currentByLetter = { X: afterModal.position.x, Y: afterModal.position.y, Z: afterModal.position.z };
  const paramByLetter = { X: xParam, Y: yParam, Z: zParam };
  const mmByLetter = {
    X: paramByLetter.X === null ? null : toMillimeters(paramByLetter.X, afterModal.unitMode),
    Y: paramByLetter.Y === null ? null : toMillimeters(paramByLetter.Y, afterModal.unitMode),
    Z: paramByLetter.Z === null ? null : toMillimeters(paramByLetter.Z, afterModal.unitMode),
  };
  const endByLetter = {
    X: resolveAxis(currentByLetter.X, mmByLetter.X, afterModal.axisPositioning),
    Y: resolveAxis(currentByLetter.Y, mmByLetter.Y, afterModal.axisPositioning),
    Z: resolveAxis(currentByLetter.Z, mmByLetter.Z, afterModal.axisPositioning),
  };

  const start2D = { a: currentByLetter[axes.aLetter], b: currentByLetter[axes.bLetter] };
  const end2D = { a: endByLetter[axes.aLetter], b: endByLetter[axes.bLetter] };
  const helicalStart = currentByLetter[axes.helicalLetter];
  const helicalEnd = endByLetter[axes.helicalLetter];

  const offsetByLetter = { I: iParam, J: jParam, K: kParam };
  const offsetAraw = offsetByLetter[axes.offsetALetter];
  const offsetBraw = offsetByLetter[axes.offsetBLetter];
  const offsetA = offsetAraw === null ? null : toMillimeters(offsetAraw, afterModal.unitMode);
  const offsetB = offsetBraw === null ? null : toMillimeters(offsetBraw, afterModal.unitMode);
  const radiusMm = rParam === null ? null : toMillimeters(rParam, afterModal.unitMode);

  const eStart = afterModal.toolEPosition[afterModal.activeTool] ?? 0;
  const eEnd = eParam === null ? eStart : afterModal.extruderPositioning === "absolute" ? toMillimeters(eParam, afterModal.unitMode) : eStart + toMillimeters(eParam, afterModal.unitMode);
  const eDelta = eEnd - eStart;

  const newState: ModalState = {
    ...afterModal,
    position: { x: endByLetter.X, y: endByLetter.Y, z: endByLetter.Z },
    toolEPosition: { ...afterModal.toolEPosition, [afterModal.activeTool]: eEnd },
  };

  const resolution = resolveCenterAndSweep(start2D, end2D, offsetA, offsetB, radiusMm, clockwise);

  if ("error" in resolution) {
    return {
      ok: false,
      state: newState,
      reason: resolution.error,
      segments: [],
      eStart,
      eEnd,
      eDelta,
      feedRate: newState.feedRate,
      subdivisionCeilingHit: false,
      temperature: afterModal.toolTemperatureSetpoints[afterModal.activeTool] ?? null,
    };
  }

  const { center, radius, sweep } = resolution;
  const { count: segmentCount, ceilingHit } = segmentCountFor(radius, sweep, limits);

  const startAngle = Math.atan2(start2D.b - center.b, start2D.a - center.a);
  const angleStep = clockwise ? -sweep / segmentCount : sweep / segmentCount;

  const segments: ArcSegment[] = [];
  let prevA = start2D.a;
  let prevB = start2D.b;
  let prevHelical = helicalStart;
  let prevE = eStart;

  for (let i = 1; i <= segmentCount; i++) {
    if (i % CANCELLATION_CHECK_INTERVAL === 0 && options.isCancelled?.()) throw new CancellationRequested();

    const t = i / segmentCount;
    const isLast = i === segmentCount;
    const angle = isLast ? startAngle + (clockwise ? -sweep : sweep) : startAngle + angleStep * i;
    const a = isLast ? end2D.a : center.a + radius * Math.cos(angle);
    const b = isLast ? end2D.b : center.b + radius * Math.sin(angle);
    const helical = helicalStart + (helicalEnd - helicalStart) * t;
    const eAt = eStart + eDelta * t;

    const startPoint = { [axes.aLetter]: prevA, [axes.bLetter]: prevB, [axes.helicalLetter]: prevHelical } as Record<"X" | "Y" | "Z", number>;
    const endPoint = { [axes.aLetter]: a, [axes.bLetter]: b, [axes.helicalLetter]: helical } as Record<"X" | "Y" | "Z", number>;

    segments.push({
      start: { x: startPoint.X, y: startPoint.Y, z: startPoint.Z },
      end: { x: endPoint.X, y: endPoint.Y, z: endPoint.Z },
      eStart: prevE,
      eEnd: eAt,
    });

    prevA = a;
    prevB = b;
    prevHelical = helical;
    prevE = eAt;
  }

  return {
    ok: true,
    state: newState,
    center,
    radius,
    sweepRadians: sweep,
    clockwise,
    segments,
    eStart,
    eEnd,
    eDelta,
    feedRate: newState.feedRate,
    subdivisionCeilingHit: ceilingHit,
    temperature: afterModal.toolTemperatureSetpoints[afterModal.activeTool] ?? null,
  };
}
