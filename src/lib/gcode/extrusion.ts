/**
 * Sequence-aware extrusion classification, built on top of
 * `linear-moves.ts`'s own per-move E delta (never merely "does this line
 * have an E token" — a move with E present but an unchanged resolved
 * value has `eDelta === 0` and is correctly reported as `"none"`).
 * Distinguishes plain extrusion from "prime" (the first positive-delta
 * move immediately following one or more retractions) — that distinction
 * needs sequence context a single move's own classification can't carry,
 * which is exactly why this is a separate pass over `linear-moves.ts`'s
 * output rather than a `MoveCategory` value itself.
 *
 * Volumetric awareness: when a move's own `volumetric` flag (set from
 * `M200`, tracked per `linear-moves.ts`) is true, `lengthMm` is always
 * `null` — this project never reports a millimeter filament length for
 * an E value that is known to represent a volume, not a length.
 */
import type { LinearMove } from "./linear-moves";

export type ExtrusionEventKind = "extrusion" | "retraction" | "prime" | "none";

export interface ExtrusionEvent {
  moveIndex: number;
  kind: ExtrusionEventKind;
  /** The move's own E delta, in whatever unit E represents (mm, or mm³ when volumetric). */
  rawDelta: number;
  /** `rawDelta` restated as a millimeter filament length — `null` whenever the move is volumetric. */
  lengthMm: number | null;
  volumetric: boolean;
}

export function classifyExtrusionEvents(moves: readonly LinearMove[]): ExtrusionEvent[] {
  const events: ExtrusionEvent[] = [];
  let pendingPrime = false;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const lengthMm = m.volumetric ? null : m.eDelta;

    if (m.eDelta === 0) {
      events.push({ moveIndex: i, kind: "none", rawDelta: 0, lengthMm: m.volumetric ? null : 0, volumetric: m.volumetric });
      continue;
    }

    if (m.eDelta < 0) {
      events.push({ moveIndex: i, kind: "retraction", rawDelta: m.eDelta, lengthMm, volumetric: m.volumetric });
      pendingPrime = true;
      continue;
    }

    const kind: ExtrusionEventKind = pendingPrime ? "prime" : "extrusion";
    events.push({ moveIndex: i, kind, rawDelta: m.eDelta, lengthMm, volumetric: m.volumetric });
    pendingPrime = false;
  }

  return events;
}
