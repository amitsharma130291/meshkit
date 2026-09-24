/**
 * Display-only formatting for the STL Optimization UI. Numeric
 * formatting reuses `stl/format.ts` unchanged, matching every other
 * tool's own convention.
 */
import { formatMagnitude, formatTriangleCount } from "../stl/format";
import type { OptimizeOutcome, EligibilityClass } from "./types";

export { formatMagnitude, formatTriangleCount };

const OUTCOME_LABELS: Record<OptimizeOutcome, string> = {
  "target-achieved": "Target achieved",
  "reduced-safely": "Reduced safely",
  "partially-reduced": "Partially reduced",
  "unchanged-no-safe-collapses": "No safe reduction available",
  "verification-incomplete": "Verification incomplete",
  "verification-failed": "Verification failed",
  cancelled: "Cancelled",
  failed: "Optimization failed",
};

export function formatOutcome(outcome: OptimizeOutcome): string {
  return OUTCOME_LABELS[outcome];
}

const ELIGIBILITY_LABELS: Record<EligibilityClass, string> = {
  eligible: "Eligible for simplification",
  "eligible-with-warnings": "Eligible, with warnings",
  "repair-recommended": "Repair recommended first",
  "unsafe-to-simplify": "Not safe to simplify automatically",
};

export function formatEligibility(eligibility: EligibilityClass): string {
  return ELIGIBILITY_LABELS[eligibility];
}

const REJECTION_LABELS: Record<string, string> = {
  "non-finite-position": "Non-finite proposed position",
  "different-shells": "Would merge two separate shells",
  "boundary-interior-mixed": "Would pull the boundary into the interior",
  "boundary-non-adjacent": "Boundary vertices not adjacent on the same loop",
  "would-create-degenerate-triangle": "Would create a degenerate triangle",
  "would-create-duplicate-triangle": "Would create a duplicate triangle",
  "link-condition-failed": "Would create non-manifold topology",
  "normal-flip-exceeded": "Would flip a surface normal too far",
  "shell-would-drop-below-minimum": "Would drop a shell below its minimum triangle count",
};

export function formatRejectionReason(reason: string): string {
  return REJECTION_LABELS[reason] ?? reason;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
