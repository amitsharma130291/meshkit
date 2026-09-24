/** Tiny display-text helpers — kept separate so wording changes don't touch detection/adapter logic. Mirrors every other domain's own small, independent copy of these helpers (see e.g. src/lib/fbx/formatting.ts) rather than a shared cross-domain import. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function describeCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

const FORMAT_LABELS: Record<string, string> = {
  stl: "STL",
  obj: "OBJ",
  "3mf": "3MF",
  glb: "GLB",
  ply: "PLY",
  fbx: "FBX",
};

export function formatDetectedFormatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}
