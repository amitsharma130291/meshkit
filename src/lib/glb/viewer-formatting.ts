/**
 * Display-only helpers for the GLB Viewer's scene tree and model info
 * panel. Nothing here parses glTF JSON or touches geometry.
 */

/** Truncates a raw glTF-provided string (node/mesh/material name) to a safe, bounded display string. */
export function sanitizeViewerText(raw: string, maxLength: number): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** Builds the scene tree's structural fallback label — used whenever a segment has no model-provided `displayName`. */
export function buildSegmentStructuralLabel(nodeIndex: number, meshIndex: number, primitiveIndex: number): string {
  return `Node ${nodeIndex} → Mesh ${meshIndex} → Primitive ${primitiveIndex}`;
}
