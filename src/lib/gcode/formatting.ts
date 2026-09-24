/**
 * Display-only formatting for the G-code Cluster UI.
 */
import type { GCodeResultStatus } from "./types";
import type { MoveCategory } from "./linear-moves";
import type { FeatureCategory } from "./features";
import type { LayerDetectionMode } from "./layers";
import type { SlicerId } from "./comments";
import type { ChecksumStatus } from "./checksum";

const STATUS_LABELS: Record<GCodeResultStatus, string> = {
  ready: "Ready",
  "ready-with-warnings": "Ready, with warnings",
  partial: "Partially processed",
  unsupported: "Not supported",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function formatGCodeStatus(status: GCodeResultStatus): string {
  return STATUS_LABELS[status];
}

const MOVE_CATEGORY_LABELS: Record<MoveCategory, string> = {
  extrusion: "Extrusion",
  travel: "Travel",
  retract: "Retract",
  "e-only-extrusion": "Extrusion (in place)",
  "e-only-retract": "Retract (in place)",
  "z-only": "Z move",
  "zero-length-state-update": "State update",
};

export function formatMoveCategory(category: MoveCategory): string {
  return MOVE_CATEGORY_LABELS[category];
}

const FEATURE_LABELS: Record<FeatureCategory, string> = {
  "outer-wall": "Outer wall",
  "inner-wall": "Inner wall",
  infill: "Infill",
  "solid-infill": "Solid infill",
  "top-surface": "Top surface",
  "bottom-surface": "Bottom surface",
  support: "Support",
  "support-interface": "Support interface",
  bridge: "Bridge",
  skirt: "Skirt",
  brim: "Brim",
  raft: "Raft",
  purge: "Purge",
  "prime-tower": "Prime tower",
  custom: "Other feature",
  "unknown-extrusion": "Unlabeled extrusion",
  travel: "Travel",
};

export function formatFeatureCategory(feature: FeatureCategory): string {
  return FEATURE_LABELS[feature];
}

const LAYER_MODE_LABELS: Record<LayerDetectionMode, string> = {
  explicit: "From the file's own layer markers",
  inferred: "Inferred from height changes",
  mixed: "Partially from markers, partially inferred",
  unknown: "Not determined",
};

export function formatLayerDetectionMode(mode: LayerDetectionMode): string {
  return LAYER_MODE_LABELS[mode];
}

const SLICER_LABELS: Record<SlicerId, string> = {
  cura: "Cura",
  prusaslicer: "PrusaSlicer",
  orcaslicer: "OrcaSlicer",
  bambustudio: "Bambu Studio",
};

export function formatSlicer(slicer: SlicerId | "unknown"): string {
  return slicer === "unknown" ? "Unknown" : SLICER_LABELS[slicer];
}

const CHECKSUM_LABELS: Record<ChecksumStatus, string> = {
  valid: "Valid",
  missing: "No checksum",
  mismatched: "Mismatched",
};

export function formatChecksumStatus(status: ChecksumStatus): string {
  return CHECKSUM_LABELS[status];
}

export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function formatDistanceMm(mm: number): string {
  if (Math.abs(mm) >= 1000) return `${(mm / 1000).toFixed(2)} m`;
  return `${mm.toFixed(1)} mm`;
}
