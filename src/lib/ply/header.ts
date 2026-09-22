/**
 * PLY header parsing. The header is always plain ASCII text, line-oriented,
 * terminated by an `end_header` line — but unlike OBJ, whatever bytes
 * follow that line are the file's BODY, which may be raw binary data. So
 * this module works directly against the raw byte array (never a full
 * `TextDecoder.decode()` of the whole buffer) and returns the exact byte
 * offset the body starts at, alongside the parsed schema.
 */
import { plyError } from "./errors";
import { normalizeScalarType } from "./scalar-types";
import type { PLYElement, PLYFormat, PLYHeader, PLYLimits, PLYProperty } from "./types";

interface LineSpan {
  /** Byte offset (inclusive) of this line's first character. */
  start: number;
  /** Byte offset (exclusive) of this line's last character — i.e. where its line-ending sequence begins. */
  end: number;
  /** Byte offset of the following line's first character. */
  nextStart: number;
}

/** Finds the next line boundary, tolerating LF, CRLF and lone-CR endings — a file need not be internally consistent about which one it uses. */
function findLineSpan(bytes: Uint8Array, start: number): LineSpan {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) return { start, end: i, nextStart: i + 1 };
    if (bytes[i] === 0x0d) {
      const nextStart = i + 1 < bytes.length && bytes[i + 1] === 0x0a ? i + 2 : i + 1;
      return { start, end: i, nextStart };
    }
  }
  return { start, end: bytes.length, nextStart: bytes.length };
}

/** The header is pure ASCII by the format's own definition, so a direct byte→char mapping is exact and byte-offset-preserving — no multi-byte decoding needed (or wanted, since we need exact byte offsets back). */
function decodeAsciiSpan(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

/**
 * Splits the header into lines, enforcing `maxHeaderBytes` as a safety
 * ceiling against a file that never contains `end_header` at all (so this
 * loop can't scan an entire huge, hostile "binary" file byte by byte
 * looking for a header that isn't there).
 */
function readHeaderLines(bytes: Uint8Array, limits: PLYLimits): { lines: string[]; bodyOffset: number } {
  const lines: string[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (offset > limits.maxHeaderBytes) throw plyError("PLY_HEADER_TOO_LARGE");
    const span = findLineSpan(bytes, offset);
    const line = decodeAsciiSpan(bytes, span.start, span.end);
    lines.push(line);
    offset = span.nextStart;
    if (line.trim() === "end_header") return { lines, bodyOffset: offset };
  }

  throw plyError("PLY_HEADER_UNTERMINATED");
}

function parseFormatLine(parts: string[]): PLYFormat {
  if (parts.length !== 3 || parts[2] !== "1.0") throw plyError("PLY_FORMAT_UNSUPPORTED");
  const token = parts[1];
  if (token !== "ascii" && token !== "binary_little_endian" && token !== "binary_big_endian") {
    throw plyError("PLY_FORMAT_UNSUPPORTED");
  }
  return token;
}

function parseElementLine(parts: string[], seenNames: Set<string>, limits: PLYLimits): PLYElement {
  if (parts.length !== 3) throw plyError("PLY_ELEMENT_INVALID");
  const name = parts[1];
  const count = Number(parts[2]);
  if (!Number.isInteger(count) || count < 0) throw plyError("PLY_ELEMENT_INVALID");
  if (seenNames.has(name)) throw plyError("PLY_ELEMENT_DUPLICATE");
  if (seenNames.size >= limits.maxElements) throw plyError("PLY_ELEMENT_LIMIT_EXCEEDED");
  return { name, count, properties: [] };
}

function parsePropertyLine(parts: string[], element: PLYElement, limits: PLYLimits): PLYProperty {
  if (element.properties.length >= limits.maxPropertiesPerElement) throw plyError("PLY_PROPERTY_LIMIT_EXCEEDED");

  let property: PLYProperty;
  if (parts[1] === "list") {
    if (parts.length !== 5) throw plyError("PLY_PROPERTY_INVALID");
    const countType = normalizeScalarType(parts[2]);
    const itemType = normalizeScalarType(parts[3]);
    if (!countType || !itemType) throw plyError("PLY_PROPERTY_INVALID");
    property = { kind: "list", countType, itemType, name: parts[4] };
  } else {
    if (parts.length !== 3) throw plyError("PLY_PROPERTY_INVALID");
    const type = normalizeScalarType(parts[1]);
    if (!type) throw plyError("PLY_PROPERTY_INVALID");
    property = { kind: "scalar", type, name: parts[2] };
  }

  if (element.properties.some((existing) => existing.name === property.name)) {
    throw plyError("PLY_PROPERTY_DUPLICATE");
  }
  return property;
}

function parseHeaderLines(lines: string[], limits: PLYLimits): PLYHeader {
  if (lines.length === 0 || lines[0].trim() !== "ply") throw plyError("PLY_MAGIC_INVALID");

  let format: PLYFormat | null = null;
  const elements: PLYElement[] = [];
  const elementNames = new Set<string>();
  let currentElement: PLYElement | null = null;

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed === "end_header") continue;

    const parts = trimmed.split(/\s+/);
    switch (parts[0]) {
      case "comment":
      case "obj_info":
        break;

      case "format":
        if (format !== null) throw plyError("PLY_FORMAT_DUPLICATE");
        format = parseFormatLine(parts);
        break;

      case "element":
        currentElement = parseElementLine(parts, elementNames, limits);
        elementNames.add(currentElement.name);
        elements.push(currentElement);
        break;

      case "property":
        if (!currentElement) throw plyError("PLY_PROPERTY_BEFORE_ELEMENT");
        currentElement.properties.push(parsePropertyLine(parts, currentElement, limits));
        break;

      default:
        throw plyError("PLY_UNKNOWN_KEYWORD");
    }
  }

  if (format === null) throw plyError("PLY_FORMAT_MISSING");
  if (elements.length === 0) throw plyError("PLY_EMPTY_GEOMETRY");

  return { format, elements };
}

export function parsePLYHeader(buffer: ArrayBuffer, limits: PLYLimits): { header: PLYHeader; bodyOffset: number } {
  const bytes = new Uint8Array(buffer);
  const { lines, bodyOffset } = readHeaderLines(bytes, limits);
  return { header: parseHeaderLines(lines, limits), bodyOffset };
}
