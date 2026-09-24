/**
 * Time estimation, deliberately kept as clearly separate SOURCES rather
 * than one blended number: the slicer's own trusted estimate (parsed
 * from a comment, if present) and MeshWrench's own feed-rate-only geometry
 * estimate. Neither ever models acceleration, jerk, junction deviation,
 * pressure advance, firmware queues, bed leveling, unsupported thermal
 * waits, or printer-specific macros — the feed-rate estimate is always
 * labelled `"feed-rate-only estimate"`, never "actual print time". A
 * third source, visual playback duration, is a runtime property of the
 * player (driven by its own playback-speed control) and isn't computed
 * here at all.
 */
import type { TokenizedLine } from "./tokenizer";
import type { MoveSegment } from "./types";

export function computeSegmentDurationSeconds(s: MoveSegment): number {
  if (s.feedRate === null || s.feedRate <= 0) return 0;
  const distance = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z);
  return (distance / s.feedRate) * 60;
}

export function computeFeedRateOnlyEstimateSeconds(segments: readonly MoveSegment[], dwellSeconds: number): number {
  let total = 0;
  for (const s of segments) total += computeSegmentDurationSeconds(s);
  return total + dwellSeconds;
}

/** G4 dwell: `P` is milliseconds, `S` is seconds. Both are summed if somehow both appear on the same line. */
export function parseDwellSeconds(token: TokenizedLine): number {
  const g4 = token.words.find((w) => w.letter === "G" && w.value === 4);
  if (!g4) return 0;
  const p = token.words.find((w) => w.letter === "P" && w.finite);
  const s = token.words.find((w) => w.letter === "S" && w.finite);
  let seconds = 0;
  if (p) seconds += p.value! / 1000;
  if (s) seconds += s.value!;
  return seconds;
}

export interface TimingEstimateInput {
  /** Already parsed from comments (e.g. Cura's `;TIME:`, PrusaSlicer/Orca's "estimated printing time") — `null` when the file never declared one. */
  slicerProvidedSeconds: number | null;
  segments: readonly MoveSegment[];
  dwellSeconds: number;
}

export interface TimingEstimate {
  slicerProvidedSeconds: number | null;
  feedRateOnlySeconds: number;
  /** A fixed, honest label — always exactly this string, never re-described as "print time". */
  feedRateOnlySource: "feed-rate-only estimate";
}

export function buildTimingEstimate(input: TimingEstimateInput): TimingEstimate {
  return {
    slicerProvidedSeconds: input.slicerProvidedSeconds,
    feedRateOnlySeconds: computeFeedRateOnlyEstimateSeconds(input.segments, input.dwellSeconds),
    feedRateOnlySource: "feed-rate-only estimate",
  };
}
