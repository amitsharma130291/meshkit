/**
 * Text decoding and line splitting for OBJ — a plain-text format, so
 * "tokenizing" here means turning raw bytes into a sequence of
 * (lineNumber, keyword, args) records, not lexing a grammar.
 */
import { objError } from "./errors";
import type { OBJLimits } from "./types";

/**
 * Decodes a raw OBJ buffer to text: prefers UTF-8, strips an optional BOM,
 * and rejects anything that can't be decoded safely. Only ever reads the
 * buffer once (a single `TextDecoder.decode()` call) — no extra
 * whole-buffer copies beyond what decoding itself requires.
 *
 * MeshKit intentionally does not guess at legacy 8-bit encodings (Latin-1,
 * Windows-1252, etc.) — UTF-8 (the OBJ ecosystem's de facto default) is the
 * only supported encoding, and a file that isn't valid UTF-8 is rejected
 * with OBJ_TEXT_DECODE_FAILED rather than silently mis-decoded.
 */
export function decodeOBJText(buffer: ArrayBuffer, limits: OBJLimits): string {
  if (buffer.byteLength > limits.maxTextBytes) {
    throw objError("OBJ_FILE_TOO_LARGE");
  }

  const bytes = new Uint8Array(buffer);
  const hasBOM = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const start = hasBOM ? 3 : 0;

  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0) throw objError("OBJ_TEXT_DECODE_FAILED");
  }

  try {
    const view = start === 0 ? bytes : bytes.subarray(start);
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    throw objError("OBJ_TEXT_DECODE_FAILED");
  }
}

export interface LogicalLine {
  /** The first physical line number this logical line started on — for internal diagnostics only, never shown to the user. */
  lineNumber: number;
  raw: string;
}

/**
 * Splits decoded OBJ text into logical lines: normalizes CRLF/LF/CR, and
 * merges a physical line ending in a trailing `\` with the next physical
 * line (OBJ's line-continuation convention), joining them with a single
 * space so a continued statement's arguments still tokenize correctly.
 */
export function* iterateLogicalLines(text: string): Generator<LogicalLine> {
  const physicalLines = text.split(/\r\n|\r|\n/);
  let pendingNumber = -1;
  let pendingParts: string[] = [];

  for (let i = 0; i < physicalLines.length; i++) {
    const lineNumber = i + 1;
    let line = physicalLines[i];
    const continues = line.endsWith("\\");
    if (continues) line = line.slice(0, -1);

    if (pendingNumber === -1) pendingNumber = lineNumber;
    pendingParts.push(line);

    if (!continues) {
      yield { lineNumber: pendingNumber, raw: pendingParts.join(" ") };
      pendingNumber = -1;
      pendingParts = [];
    }
  }

  // A file ending mid-continuation (trailing lone backslash) still yields
  // whatever content was gathered, rather than silently dropping it.
  if (pendingParts.length > 0) {
    yield { lineNumber: pendingNumber, raw: pendingParts.join(" ") };
  }
}

export interface TokenizedLine {
  keyword: string;
  args: string[];
}

/**
 * Strips a `#` comment (full-line or trailing), then splits on whitespace
 * runs. Returns null for a blank or comment-only line. Uses only
 * fixed-quantifier patterns (`\s+`), never a nested/backtracking regex.
 */
export function tokenizeLine(raw: string): TokenizedLine | null {
  const hashIndex = raw.indexOf("#");
  const withoutComment = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const trimmed = withoutComment.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(/\s+/);
  return { keyword: parts[0], args: parts.slice(1) };
}
