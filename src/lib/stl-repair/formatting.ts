/**
 * Display-only formatting for the STL Repair UI. Numeric formatting
 * reuses `stl/format.ts` unchanged; outcome/operation labels are the
 * only new vocabulary this module adds.
 */
import { formatMagnitude, formatTriangleCount } from "../stl/format";
import type { RepairOperation, RepairOutcome } from "./types";

export { formatMagnitude, formatTriangleCount };

const OUTCOME_LABELS: Record<RepairOutcome, string> = {
  "fully-repaired": "Fully repaired",
  improved: "Improved",
  unchanged: "No changes needed",
  "partially-repaired": "Partially repaired",
  "unable-to-repair-safely": "Unable to repair safely",
  failed: "Repair failed",
  cancelled: "Cancelled",
};

export function formatOutcome(outcome: RepairOutcome): string {
  return OUTCOME_LABELS[outcome];
}

const OPERATION_LABELS: Record<RepairOperation, string> = {
  "weld-vertices": "Weld nearby vertices",
  "remove-repeated-vertex-triangles": "Remove repeated-vertex triangles",
  "remove-exact-zero-area-triangles": "Remove exact-zero-area triangles",
  "remove-near-zero-area-triangles": "Remove near-zero-area triangles",
  "remove-same-winding-duplicate-faces": "Remove same-winding duplicate faces",
  "remove-reverse-winding-duplicate-faces": "Remove reverse-winding duplicate faces",
  "correct-winding": "Correct inconsistent winding",
  "orient-outward-closed-shells": "Orient closed shells outward",
  "fill-eligible-holes": "Fill eligible boundary loops",
  "remove-small-shells": "Remove small disconnected shells",
};

export function formatOperation(operation: RepairOperation): string {
  return OPERATION_LABELS[operation];
}

const HOLE_SKIP_LABELS: Record<string, string> = {
  "not-a-closed-loop": "Not a simple closed loop",
  "vertex-count-limit": "Too many vertices for this loop",
  "perimeter-limit": "Loop perimeter exceeds the safety limit",
  "area-limit": "Loop area exceeds the safety limit",
  "planarity-limit": "Loop deviates too far from a flat plane",
  "self-intersecting-boundary": "Loop boundary self-intersects",
  "triangulation-failed": "Triangulation failed",
  "patch-triangle-limit": "Patch would need too many triangles",
  "hole-count-limit": "Hole-count safety limit reached",
};

export function formatHoleSkipReason(reason: string): string {
  return HOLE_SKIP_LABELS[reason] ?? reason;
}
