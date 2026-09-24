/**
 * Deterministic, safe output filenames for batch results. A source
 * filename is untrusted input — it may carry a fake relative path, raw
 * control characters, a Windows-reserved device name, or be absurdly
 * long — none of that is ever passed through to an output filename.
 */
const MAX_STEM_LENGTH = 120;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Takes only the last path segment — a source name is never trusted as a real path, whether it uses `/` or `\`. */
function lastPathSegment(rawName: string): string {
  const segments = rawName.split(/[/\\]+/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "";
}

function splitExtension(name: string): { stem: string; extension: string } {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, idx), extension: name.slice(idx + 1) };
}

/** Sanitizes a full (stem + extension) filename — strips path components, control characters, trailing dots/whitespace, rewrites reserved device names, and bounds its length. Never returns an empty string. */
export function sanitizeFilenameStem(rawName: string): string {
  let name = lastPathSegment(rawName).replace(/[\x00-\x1f\x7f]/g, "");
  name = name.trim().replace(/[.\s]+$/, "");

  if (name === "") return "file";

  const { stem, extension } = splitExtension(name);
  let safeStem = stem === "" ? "file" : stem;

  if (RESERVED_WINDOWS_NAMES.has(safeStem.toUpperCase())) safeStem = `_${safeStem}`;
  if (safeStem.length > MAX_STEM_LENGTH) safeStem = safeStem.slice(0, MAX_STEM_LENGTH);

  return extension ? `${safeStem}.${extension}` : safeStem;
}

/** Tracks names already handed out for one batch's outputs, appending the documented `" (2)"`, `" (3)"`... suffix on a collision. Case-insensitive, since case-insensitive filesystems (Windows, default macOS) would otherwise silently collide anyway. */
export class FilenameCollisionTracker {
  private readonly used = new Set<string>();

  reserve(candidate: string): string {
    let name = candidate;
    let suffix = 2;
    const { stem, extension } = splitExtension(candidate);
    while (this.used.has(name.toLowerCase())) {
      name = extension ? `${stem} (${suffix}).${extension}` : `${stem} (${suffix})`;
      suffix++;
    }
    this.used.add(name.toLowerCase());
    return name;
  }
}

/** Builds a deterministic output filename: sanitize the source name, replace its extension, then resolve any collision against everything already reserved in this batch. */
export function buildOutputFilename(sourceFileName: string, outputExtension: string, tracker: FilenameCollisionTracker): string {
  const sanitized = sanitizeFilenameStem(sourceFileName);
  const { stem } = splitExtension(sanitized);
  const candidate = `${stem || "file"}.${outputExtension}`;
  return tracker.reserve(candidate);
}
