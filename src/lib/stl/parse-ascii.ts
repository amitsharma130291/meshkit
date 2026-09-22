import { stlError } from "./errors";
import type { STLParseLimits } from "./types";
import type { RawSTLGeometry } from "./parse-binary";

// A single linear token pattern (no nesting/alternation that could
// backtrack) — safe from catastrophic-regex behavior regardless of input size.
const TOKEN_PATTERN = /\S+/g;

/**
 * Parses ASCII STL text into the same raw shape the binary parser produces.
 * Tokenizes the whole file once up front (whitespace/newline-insensitive by
 * construction — no line-based assumptions) and walks it as a flat token
 * stream, which naturally accepts any mix of spacing/newlines and
 * upper/lower/mixed-case keywords.
 */
export function parseAsciiSTL(text: string, limits: STLParseLimits): RawSTLGeometry {
  const tokens = text.match(TOKEN_PATTERN);
  if (!tokens || tokens.length === 0) {
    throw stlError("STL_ASCII_MALFORMED");
  }

  let cursor = 0;
  const next = (): string => {
    if (cursor >= tokens.length) throw stlError("STL_ASCII_MALFORMED");
    return tokens[cursor++];
  };
  const peekLower = (): string | undefined => tokens[cursor]?.toLowerCase();
  const expectKeyword = (keyword: string): void => {
    if (next().toLowerCase() !== keyword) throw stlError("STL_ASCII_MALFORMED");
  };
  const nextNumber = (): number => {
    const value = Number(next());
    if (!Number.isFinite(value)) throw stlError("STL_NON_FINITE_VERTEX");
    return value;
  };

  if (peekLower() !== "solid") {
    throw stlError("STL_ASCII_MALFORMED");
  }
  next(); // consume "solid"

  let header: string | undefined;
  const nameParts: string[] = [];
  while (peekLower() !== undefined && peekLower() !== "facet" && peekLower() !== "endsolid") {
    nameParts.push(next());
  }
  if (nameParts.length > 0) header = nameParts.join(" ");

  const positions: number[] = [];
  const normals: number[] = [];
  let triangleCount = 0;

  while (peekLower() === "facet") {
    next(); // "facet"
    expectKeyword("normal");
    const nx = nextNumber();
    const ny = nextNumber();
    const nz = nextNumber();

    expectKeyword("outer");
    expectKeyword("loop");

    const vertices: number[] = [];
    for (let v = 0; v < 3; v++) {
      expectKeyword("vertex");
      vertices.push(nextNumber(), nextNumber(), nextNumber());
    }

    // A 4th "vertex" before "endloop" means more than three vertices — reject.
    if (peekLower() === "vertex") {
      throw stlError("STL_ASCII_MALFORMED");
    }

    expectKeyword("endloop");
    expectKeyword("endfacet");

    if (triangleCount >= limits.maxTriangles) {
      throw stlError("STL_TOO_COMPLEX");
    }

    for (let v = 0; v < 3; v++) {
      positions.push(vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]);
      normals.push(nx, ny, nz);
    }
    triangleCount++;
  }

  if (triangleCount === 0) {
    throw stlError("STL_EMPTY_GEOMETRY");
  }

  return {
    triangleCount,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    header,
  };
}
