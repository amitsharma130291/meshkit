import { computeBounds } from "./bounds";
import { detectSTLEncoding } from "./detect";
import { STLParseException, stlError } from "./errors";
import { resolveNormals } from "./normals";
import { parseBinarySTL, type RawSTLGeometry } from "./parse-binary";
import { parseAsciiSTL } from "./parse-ascii";
import type { STLEncoding, STLParseLimits, STLParseResult } from "./types";

/**
 * Parses an STL buffer end to end: detect encoding, parse raw geometry,
 * resolve normals, compute bounds. This is the only export other code
 * (the worker, tests) should call — parse-binary.ts/parse-ascii.ts are
 * implementation details.
 */
export function parseSTL(buffer: ArrayBuffer, limits: STLParseLimits): STLParseResult {
  if (buffer.byteLength === 0) {
    throw stlError("STL_EMPTY_GEOMETRY");
  }

  const detection = detectSTLEncoding(buffer);
  let encoding: STLEncoding = detection.encoding;
  let raw: RawSTLGeometry;

  try {
    raw = parseByEncoding(encoding, buffer, limits);
  } catch (error) {
    if (detection.confident || !(error instanceof STLParseException)) {
      throw error;
    }
    // Ambiguous detection and the first guess failed — try the other
    // format once before giving up, rather than surfacing a possibly
    // misleading error for what might just be a mis-guessed format.
    const fallbackEncoding: STLEncoding = encoding === "binary" ? "ascii" : "binary";
    try {
      raw = parseByEncoding(fallbackEncoding, buffer, limits);
      encoding = fallbackEncoding;
    } catch {
      throw stlError("STL_FORMAT_UNRECOGNIZED");
    }
  }

  const normals = resolveNormals(raw.positions, raw.normals);
  const bounds = computeBounds(raw.positions);

  return {
    encoding,
    triangleCount: raw.triangleCount,
    positions: raw.positions,
    normals,
    bounds,
    header: raw.header,
  };
}

function parseByEncoding(encoding: STLEncoding, buffer: ArrayBuffer, limits: STLParseLimits): RawSTLGeometry {
  if (encoding === "binary") {
    return parseBinarySTL(buffer, limits);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  return parseAsciiSTL(text, limits);
}
