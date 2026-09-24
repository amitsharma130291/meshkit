/**
 * Content-based format detection for `/viewer/`. Every check here reuses
 * an existing, already-tested piece of a production parser rather than a
 * second, possibly-diverging sniff: `stl/detect.ts`'s own binary-length
 * formula and ASCII-STL heuristic, `threemf/package.ts`'s ZIP central-
 * directory reader plus `threemf/relationships.ts`'s real OPC
 * relationship resolution (never a bare ZIP-magic-equals-3MF guess), and
 * PLY/GLB/FBX's own documented magic bytes. Detection never fully parses
 * a file — every check reads a small, fixed prefix (or, for 3MF, only
 * the ZIP central directory plus the tiny `_rels/.rels` entry) and never
 * throws; an exception from a reused validator is caught and treated as
 * "not this format," never propagated as a detection failure.
 *
 * Extension is informational only. `extensionMatches` reports whether the
 * caller's declared extension agrees with what content-detection actually
 * found, for the UI's own mismatch warning — it is never consulted to
 * pick or override the detected format.
 */
import { BINARY_HEADER_BYTES, BINARY_TRIANGLE_RECORD_BYTES, looksLikeAsciiSTL } from "../stl/detect";
import { openThreeMFPackage } from "../threemf/package";
import { findPrimaryModelPath } from "../threemf/relationships";
import { DEFAULT_THREEMF_LIMITS } from "../threemf/types";

export type DetectedFormat = "stl" | "obj" | "3mf" | "glb" | "ply" | "fbx";
export type DetectionConfidence = "certain" | "strong" | "tentative" | "none";

export interface DetectionResult {
  /** `null` when content is genuinely unknown or too ambiguous to dispatch safely — see the module doc for why this differs from a bare `DetectedFormat`. */
  format: DetectedFormat | null;
  confidence: DetectionConfidence;
  /** A fixed, descriptive template — never raw file bytes, a decoded text sample, or any other file-derived string. */
  reason: string;
  /** `null` when the file has no extension, or one this tool doesn't recognize at all — there is nothing meaningful to compare. */
  extensionMatches: boolean | null;
}

/** Every extension `/viewer/`'s own file picker accepts, mapped to the format it conventionally means — used only for the `extensionMatches` signal, never to pick the result. */
const KNOWN_EXTENSIONS: Record<string, DetectedFormat> = {
  stl: "stl",
  obj: "obj",
  "3mf": "3mf",
  glb: "glb",
  gltf: "glb",
  ply: "ply",
  fbx: "fbx",
};

/** Bounded text-prefix size for every heuristic below (PLY header scan, ASCII-STL, ASCII-FBX marker, OBJ record keywords) — large enough for a realistic header/opening lines, small regardless of the file's real size. Never grown to "read until a signal is found." */
const TEXT_PREFIX_BYTES = 8192;

const GLB_MAGIC = 0x46546c67; // "glTF", little-endian uint32
const FBX_MAGIC_TEXT = "Kaydara FBX Binary";
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_EMPTY_ARCHIVE_SIGNATURE = 0x06054b50; // a valid (empty) ZIP has only an End Of Central Directory record

function extensionMatchesFormat(declaredExtension: string | null, format: DetectedFormat | null): boolean | null {
  if (!declaredExtension) return null;
  const normalized = declaredExtension.toLowerCase().replace(/^\./, "");
  const expected = KNOWN_EXTENSIONS[normalized];
  if (expected === undefined) return null;
  if (format === null) return null;
  return expected === format;
}

function textPrefix(buffer: ArrayBuffer): string {
  const length = Math.min(buffer.byteLength, TEXT_PREFIX_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buffer, 0, length));
  } catch {
    return "";
  }
}

function detectGLB(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) return false;
  // Reject an impossible/truncated container before ever dispatching to the real parser: version must be the one glTF-Binary version, and the declared total length must be at least the 12-byte header.
  const version = view.getUint32(4, true);
  const declaredLength = view.getUint32(8, true);
  return version === 2 && declaredLength >= 12;
}

function detectFBXBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < FBX_MAGIC_TEXT.length) return false;
  const bytes = new Uint8Array(buffer, 0, FBX_MAGIC_TEXT.length);
  for (let i = 0; i < FBX_MAGIC_TEXT.length; i++) {
    if (bytes[i] !== FBX_MAGIC_TEXT.charCodeAt(i)) return false;
  }
  return true;
}

/** A distinctive, FBX-specific ASCII marker — deliberately not just "starts with a semicolon comment," which plenty of non-FBX text could also do. */
function detectFBXAscii(prefix: string): boolean {
  return prefix.includes("FBXHeaderExtension");
}

function detectPLY(buffer: ArrayBuffer): { matched: boolean; hasSupportedFormat: boolean } {
  // Decoded with a raw per-byte charCode mapping — deliberately NOT a real
  // UTF-8 `TextDecoder`, and for a subtle reason: header.ts's own
  // `decodeAsciiSpan` (the production parser) does the exact same raw
  // byte→char mapping, not proper UTF-8 decoding, so a 3-byte UTF-8 BOM
  // becomes three ordinary non-whitespace characters (not the single
  // U+FEFF codepoint) in the resulting string. That distinction actually
  // matters: U+FEFF is itself part of JS's `trim()` whitespace class, so a
  // *real* UTF-8 decode (which turns the BOM into either nothing or a
  // single U+FEFF) would have `"﻿ply".trim()` silently succeed,
  // detecting a file the production parser's own raw-byte
  // `lines[0].trim() !== "ply"` check actually rejects as
  // `PLY_MAGIC_INVALID`. Mirroring the raw-byte decode exactly keeps this
  // detector's verdict consistent with what dispatching to the real PLY
  // pipeline will actually do.
  const length = Math.min(buffer.byteLength, TEXT_PREFIX_BYTES);
  const bytes = new Uint8Array(buffer, 0, length);
  let prefix = "";
  for (let i = 0; i < bytes.length; i++) prefix += String.fromCharCode(bytes[i]);

  // Same line-ending tolerance (LF/CRLF/lone-CR) as header.ts's own findLineSpan, but bounded to the prefix only.
  const firstLineEnd = prefix.search(/\r\n|\r|\n/);
  const firstLine = (firstLineEnd === -1 ? prefix : prefix.slice(0, firstLineEnd)).trim();
  if (firstLine !== "ply") return { matched: false, hasSupportedFormat: false };

  const hasSupportedFormat = /(^|\r\n|\r|\n)\s*format\s+(ascii|binary_little_endian|binary_big_endian)\s+1\.0\s*($|\r\n|\r|\n)/.test(prefix);
  return { matched: true, hasSupportedFormat };
}

function detectZipSignature(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const magic = new DataView(buffer).getUint32(0, true);
  return magic === ZIP_LOCAL_FILE_SIGNATURE || magic === ZIP_EMPTY_ARCHIVE_SIGNATURE;
}

/** Confirms a genuine 3MF OPC package structure (a resolvable primary model relationship) — never a bare "it's a ZIP" guess. Reads only the ZIP central directory plus the tiny `_rels/.rels` entry, never the model part itself. */
function detectThreeMF(buffer: ArrayBuffer): boolean {
  try {
    const pkg = openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS);
    const modelPath = findPrimaryModelPath(pkg);
    return pkg.entryNames.has(modelPath);
  } catch {
    return false;
  }
}

/** `84 + triangleCount * 50`, with the ceiling and comparison it already uses (JS numbers are exact integers well past any real triangle count × 50, so this is overflow-safe without special-casing). */
function detectBinarySTL(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < BINARY_HEADER_BYTES + 4) return false;
  const view = new DataView(buffer);
  const declaredTriangleCount = view.getUint32(BINARY_HEADER_BYTES, true);
  const expectedLength = BINARY_HEADER_BYTES + 4 + declaredTriangleCount * BINARY_TRIANGLE_RECORD_BYTES;
  return expectedLength === buffer.byteLength;
}

const OBJ_RECORD_KEYWORDS = new Set(["v", "vn", "vt", "f", "l", "p", "o", "g", "usemtl", "mtllib", "s"]);
/** How many distinct coherent OBJ record lines (in the bounded prefix) are required before text is confidently classified as OBJ — comments and blank lines don't count against this, but arbitrary prose or another text format's own syntax won't pass it either. */
const OBJ_MIN_MATCHING_LINES = 2;

function detectOBJ(prefix: string): boolean {
  let matches = 0;
  let sawVertexOrFace = false;
  for (const rawLine of prefix.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const keyword = line.split(/\s+/, 1)[0];
    if (OBJ_RECORD_KEYWORDS.has(keyword)) {
      matches++;
      if (keyword === "v" || keyword === "f") sawVertexOrFace = true;
      if (matches >= OBJ_MIN_MATCHING_LINES && sawVertexOrFace) return true;
    } else {
      // A line that isn't blank, a comment, or a recognized OBJ record at all — real OBJ text won't have many of these near the top of the file.
      return false;
    }
  }
  return false;
}

export function detectFormat(buffer: ArrayBuffer, declaredExtension: string | null): DetectionResult {
  const finish = (format: DetectedFormat | null, confidence: DetectionConfidence, reason: string): DetectionResult => ({
    format,
    confidence,
    reason,
    extensionMatches: extensionMatchesFormat(declaredExtension, format),
  });

  if (buffer.byteLength === 0) {
    return finish(null, "none", "The file is empty.");
  }

  if (detectGLB(buffer)) {
    return finish("glb", "certain", "Binary glTF (GLB) magic header and a valid version 2 declaration.");
  }

  if (detectFBXBinary(buffer)) {
    return finish("fbx", "certain", "Binary FBX magic header detected.");
  }

  if (detectZipSignature(buffer)) {
    if (detectThreeMF(buffer)) {
      return finish("3mf", "certain", "ZIP package with a valid 3MF content-types and model-relationship structure.");
    }
    return finish(null, "none", "This is a ZIP archive, but not a valid 3MF package.");
  }

  if (detectBinarySTL(buffer)) {
    return finish("stl", "certain", "Binary STL: the declared triangle count matches the file's exact length.");
  }

  const ply = detectPLY(buffer);
  if (ply.matched) {
    return finish("ply", ply.hasSupportedFormat ? "certain" : "tentative", ply.hasSupportedFormat ? "PLY header with a supported format declaration." : "PLY header found, but no supported format declaration in the sampled prefix.");
  }

  if (looksLikeAsciiSTL(buffer)) {
    return finish("stl", "strong", "ASCII STL structure detected (a solid declaration with facet normal records).");
  }

  const prefix = textPrefix(buffer);
  if (detectFBXAscii(prefix)) {
    return finish("fbx", "strong", "ASCII FBX text detected — this viewer only supports binary FBX.");
  }

  if (detectOBJ(prefix)) {
    return finish("obj", "strong", "Recognized OBJ record keywords in the file's opening text.");
  }

  return finish(null, "none", "This file's format couldn't be confidently identified.");
}
