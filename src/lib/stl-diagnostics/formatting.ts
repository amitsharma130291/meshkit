/**
 * Display-only formatting for the STL Diagnostics UI — plain-language
 * labels for the report's own stable codes (`WatertightVerdict`,
 * `VerdictReasonCode`, boundary component kinds, shell orientation).
 * Numeric formatting (triangle counts, magnitudes) reuses
 * `src/lib/stl/format.ts` unchanged rather than a second implementation.
 */
import { formatMagnitude, formatTriangleCount } from "../stl/format";
import type { BoundaryComponentKind } from "../mesh/boundary-components";
import type { ShellOrientationVerdict } from "../mesh/orientation";
import type { VerdictReasonCode, WatertightVerdict } from "./types";

export { formatMagnitude, formatTriangleCount };

const VERDICT_LABELS: Record<WatertightVerdict, string> = {
  watertight: "Watertight",
  "not-watertight": "Not watertight",
  "invalid-topology": "Invalid topology",
  indeterminate: "Some checks incomplete",
};

export function formatVerdict(verdict: WatertightVerdict): string {
  return VERDICT_LABELS[verdict];
}

const REASON_LABELS: Record<VerdictReasonCode, string> = {
  "no-valid-triangles": "This file has no usable (non-degenerate) triangles.",
  "has-boundary-edges": "The surface has open (boundary) edges.",
  "has-non-manifold-edges": "The surface has non-manifold edges (shared by more than two triangles).",
  "has-winding-conflicts": "Adjacent triangles disagree on winding direction.",
  "has-duplicate-faces": "Duplicate (stacked) triangles were found.",
  "self-intersections-found": "Self-intersecting triangles were found.",
  "self-intersections-not-checked": "The self-intersection check couldn't complete within this checker's safety limits.",
  "all-checks-passed": "No topology issues were found.",
};

export function formatReasonCode(code: VerdictReasonCode): string {
  return REASON_LABELS[code];
}

const BOUNDARY_KIND_LABELS: Record<BoundaryComponentKind, string> = {
  "closed-loop": "Closed loop (potential hole)",
  "open-chain": "Open chain",
  branched: "Branched",
  "non-simple": "Non-simple",
};

export function formatBoundaryComponentKind(kind: BoundaryComponentKind): string {
  return BOUNDARY_KIND_LABELS[kind];
}

const SHELL_ORIENTATION_LABELS: Record<ShellOrientationVerdict, string> = {
  outward: "Outward",
  inward: "Inward (possibly inverted)",
  indeterminate: "Indeterminate",
};

export function formatShellOrientation(orientation: ShellOrientationVerdict): string {
  return SHELL_ORIENTATION_LABELS[orientation];
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function describeCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${formatTriangleCount(count)} ${pluralize(count, singular, plural)}`;
}

export function formatSignedVolume(volume: number | null): string {
  if (volume === null) return "—";
  return formatMagnitude(volume);
}
