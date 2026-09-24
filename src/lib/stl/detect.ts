import type { STLEncoding } from "./types";

export const BINARY_HEADER_BYTES = 80;
export const BINARY_TRIANGLE_RECORD_BYTES = 50; // 12 (normal) + 3*12 (vertices) + 2 (attribute byte count)

export interface STLDetectionResult {
  encoding: STLEncoding;
  /** False when neither signal was conclusive and `encoding` is only a best guess. */
  confident: boolean;
}

/**
 * Distinguishes binary from ASCII STL. Deliberately does NOT trust whether
 * the file starts with the literal bytes "solid" — binary STL headers are
 * 80 bytes of free-form text, and many binary exporters (SolidWorks,
 * Simplify3D, etc.) write "solid ..." there for compatibility with naive
 * sniffers. The authoritative signal is that a binary file's length is
 * fully determined by its declared triangle count.
 */
export function detectSTLEncoding(buffer: ArrayBuffer): STLDetectionResult {
  if (buffer.byteLength >= BINARY_HEADER_BYTES + 4) {
    const view = new DataView(buffer);
    const declaredTriangleCount = view.getUint32(BINARY_HEADER_BYTES, true);
    const expectedBinaryLength =
      BINARY_HEADER_BYTES + 4 + declaredTriangleCount * BINARY_TRIANGLE_RECORD_BYTES;

    if (expectedBinaryLength === buffer.byteLength) {
      return { encoding: "binary", confident: true };
    }
  }

  if (looksLikeAsciiSTL(buffer)) {
    return { encoding: "ascii", confident: true };
  }

  // Neither signal was conclusive (e.g. a truncated/corrupted binary file).
  // Default to binary since it has a hard, checkable structure — the binary
  // parser will reject it with a specific, useful error rather than the
  // ASCII parser producing a more confusing "malformed" message for what is
  // actually truncated binary data. parse.ts retries the other format once
  // before giving up when `confident` is false.
  return { encoding: "binary", confident: false };
}

/** Exported for `src/lib/viewer/format-detection.ts` (Phase 4F) — the universal viewer's own ASCII-STL sniff reuses this exact heuristic rather than a second, possibly-diverging one. */
export function looksLikeAsciiSTL(buffer: ArrayBuffer): boolean {
  const sampleLength = Math.min(buffer.byteLength, 4096);
  if (sampleLength === 0) return false;

  let sample: string;
  try {
    sample = new TextDecoder("ascii").decode(new Uint8Array(buffer, 0, sampleLength));
  } catch {
    return false;
  }

  return /^\s*solid\b/i.test(sample) && /\bfacet\s+normal\b/i.test(sample);
}
