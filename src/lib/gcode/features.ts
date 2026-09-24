/**
 * Normalizes a slicer's own bounded feature-comment label (from
 * `comments.ts`'s `featureLabel`) into one of this project's fixed
 * display categories. Purely a label→category lookup — it never reads
 * or affects motion coordinates. A `travel` move is always `"travel"`
 * regardless of any stray label; an extruding move with NO label at all
 * is `"unknown-extrusion"`; an extruding move with a real label this
 * project doesn't specifically recognize is `"custom"` — these are
 * deliberately different states so the UI can say "no feature
 * information" vs. "a feature type MeshWrench doesn't have a dedicated
 * bucket for" honestly.
 */
import type { MoveCategory } from "./linear-moves";

export type FeatureCategory =
  | "outer-wall"
  | "inner-wall"
  | "infill"
  | "solid-infill"
  | "top-surface"
  | "bottom-surface"
  | "support"
  | "support-interface"
  | "bridge"
  | "skirt"
  | "brim"
  | "raft"
  | "purge"
  | "prime-tower"
  | "custom"
  | "unknown-extrusion"
  | "travel";

const RULES: Array<[RegExp, FeatureCategory]> = [
  [/bridge/i, "bridge"],
  [/support.*interface|interface.*support/i, "support-interface"],
  [/support/i, "support"],
  [/skirt/i, "skirt"],
  [/brim/i, "brim"],
  [/raft/i, "raft"],
  [/prime.?tower/i, "prime-tower"],
  [/purge/i, "purge"],
  [/top.*(solid|surface)/i, "top-surface"],
  [/bottom.*(solid|surface)/i, "bottom-surface"],
  [/solid infill/i, "solid-infill"],
  [/wall-outer|outer wall|external perimeter/i, "outer-wall"],
  [/wall-inner|inner wall|^perimeter$/i, "inner-wall"],
  [/infill|^fill$/i, "infill"],
];

export function classifyFeatureLabel(rawLabel: string | null, moveCategory: MoveCategory): FeatureCategory {
  if (moveCategory === "travel") return "travel";
  if (!rawLabel || rawLabel.trim().length === 0) return "unknown-extrusion";

  const trimmed = rawLabel.trim();
  for (const [pattern, category] of RULES) {
    if (pattern.test(trimmed)) return category;
  }
  return "custom";
}
