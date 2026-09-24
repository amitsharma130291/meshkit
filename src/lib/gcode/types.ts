/**
 * Shared cross-module types for the G-code engine. Per-module types
 * (tokenizer, modal state, arcs, etc.) stay colocated with the module
 * that produces them — this file only holds the shapes that genuinely
 * cross module boundaries: the unified render/statistics segment shape,
 * and the final analysis result contract.
 */
import type { MoveCategory } from "./linear-moves";
import type { FeatureCategory } from "./features";

/** One straight render segment — either an entire G0/G1 move, or one subdivided piece of a G2/G3 arc. Feature/layer/tool context is resolved at the time the segment is produced, from the modal/comment state carried forward by `analyze.ts`'s own single pass — never a separate post-pass over raw coordinates. */
export interface MoveSegment {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  category: MoveCategory;
  feature: FeatureCategory;
  tool: number;
  feedRate: number | null;
  eDelta: number;
  rapid: boolean;
  volumetric: boolean;
  layerIndex: number | null;
  sourceLineIndex: number;
  /** The active tool's own target nozzle temperature at the time of this segment — never bed temperature — `null` until a valid M104/M109 has been seen for that tool. */
  temperature: number | null;
}

export type GCodeResultStatus = "ready" | "ready-with-warnings" | "partial" | "unsupported" | "cancelled" | "failed";
