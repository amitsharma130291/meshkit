/**
 * Display-only helpers for the OBJ Viewer's scene tree and model info panel.
 * Nothing here parses OBJ or touches geometry — see viewer-geometry.ts for
 * that. Kept separate so wording/label changes never touch parsing logic,
 * mirroring the existing formatting.ts/format.ts split in this codebase.
 */
export { describeCount, pluralize } from "./formatting";

/**
 * Truncates a raw OBJ name token (object/group/material name) to a safe,
 * bounded display string. Applied at the point a name is first stored, so
 * nothing downstream ever holds more than `maxLength` characters of
 * attacker-controlled text per name.
 */
export function sanitizeViewerName(raw: string, maxLength: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function formatSmoothingGroup(smoothingGroup: number | null): string {
  return smoothingGroup === null ? "Off" : `Group ${smoothingGroup}`;
}

export function formatMaterialName(materialName: string | null): string {
  return materialName ?? "None";
}
