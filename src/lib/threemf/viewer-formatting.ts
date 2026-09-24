/**
 * Display-only helpers for the 3MF Viewer's scene tree, metadata panel and
 * model info panel. Nothing here parses XML or touches geometry.
 */

/** Truncates a raw model-provided string (object/material name, metadata value) to a safe, bounded display string. Applied at the point a value is first stored. */
export function sanitizeViewerText(raw: string, maxLength: number): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
}

const KNOWN_METADATA_LABELS: Record<string, string> = {
  Title: "Title",
  Designer: "Designer",
  Description: "Description",
  Copyright: "Copyright",
  LicenseTerms: "License terms",
  CreationDate: "Created",
  ModificationDate: "Modified",
  Application: "Application",
};

/** A friendlier label for a well-known 3MF metadata key, falling back to the raw (already-sanitized) name for anything else. */
export function formatMetadataLabel(name: string): string {
  return KNOWN_METADATA_LABELS[name] ?? name;
}

/** Builds the scene tree's structural fallback label — used whenever a segment has no model-provided `displayName`. */
export function buildSegmentStructuralLabel(buildItemIndex: number, componentPath: number[], meshObjectId: string): string {
  const parts = [`Build item ${buildItemIndex + 1}`];
  for (const step of componentPath) parts.push(`Component ${step}`);
  parts.push(`Object ${meshObjectId}`);
  return parts.join(" → ");
}
