/**
 * Aggregates per-comment `SlicerCommentSignal`s (from `comments.ts`) into
 * one whole-file dialect inference. High confidence only when an
 * explicit generator header comment was actually seen; a file with only
 * generic layer/feature comment vocabulary (no header) is reported as
 * `"unknown"` rather than guessed at — this project never claims to
 * fingerprint a slicer from output style alone.
 */
import type { SlicerCommentSignal, SlicerId } from "./comments";

export interface DialectInference {
  slicer: SlicerId | "unknown";
  confidence: "high" | "low";
}

export function inferDialect(signals: readonly SlicerCommentSignal[]): DialectInference {
  const counts = new Map<SlicerId, number>();
  for (const s of signals) {
    if (s.slicerHint) counts.set(s.slicerHint, (counts.get(s.slicerHint) ?? 0) + 1);
  }
  if (counts.size === 0) return { slicer: "unknown", confidence: "low" };

  let best: SlicerId = "cura";
  let bestCount = -1;
  for (const [slicer, count] of counts) {
    if (count > bestCount) {
      best = slicer;
      bestCount = count;
    }
  }
  return { slicer: best, confidence: "high" };
}
