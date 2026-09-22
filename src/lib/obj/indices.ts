/**
 * OBJ face-reference index resolution: positive one-based, or negative
 * relative to however many elements of that kind exist at the point the
 * face line is being parsed. Callers MUST pass the count accumulated so
 * far (not a final file total) — see parser.ts, which resolves each face
 * inline during its single forward pass for exactly this reason.
 */
import { objError } from "./errors";

/** Resolves a raw (possibly negative) OBJ index against `count` items available so far. Returns a 0-based absolute index. */
export function resolveIndex(raw: number, count: number): number {
  if (raw === 0) throw objError("OBJ_INDEX_ZERO");

  const resolved = raw > 0 ? raw - 1 : count + raw;
  if (resolved < 0 || resolved >= count) throw objError("OBJ_INDEX_OUT_OF_RANGE");
  return resolved;
}

export interface FaceVertexRef {
  /** 0-based absolute index into the vertex position list. */
  vertexIndex: number;
  /** 0-based absolute index into the texture-coordinate list, or null if this reference omits vt. */
  texCoordIndex: number | null;
  /** 0-based absolute index into the normal list, or null if this reference omits vn. */
  normalIndex: number | null;
}

function parseIndexInt(text: string): number {
  if (!/^[+-]?\d+$/.test(text)) throw objError("OBJ_FACE_INVALID");
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw objError("OBJ_FACE_INVALID");
  return n;
}

/**
 * Parses one whitespace-delimited face-vertex token in any of the four
 * legal forms — `v`, `v/vt`, `v//vn`, `v/vt/vn` — and resolves each
 * present index against the counts supplied. Any other shape (empty
 * vertex index, a bare trailing/leading slash, more than three slash
 * fields) is a malformed separator and is rejected.
 */
export function parseFaceVertexToken(
  token: string,
  vertexCount: number,
  texCoordCount: number,
  normalCount: number,
): FaceVertexRef {
  const parts = token.split("/");
  if (parts.length < 1 || parts.length > 3 || parts[0] === "") {
    throw objError("OBJ_FACE_INVALID");
  }

  const vertexIndex = resolveIndex(parseIndexInt(parts[0]), vertexCount);
  let texCoordIndex: number | null = null;
  let normalIndex: number | null = null;

  if (parts.length === 2) {
    if (parts[1] === "") throw objError("OBJ_FACE_INVALID"); // "v/" with nothing after
    texCoordIndex = resolveIndex(parseIndexInt(parts[1]), texCoordCount);
  } else if (parts.length === 3) {
    if (parts[1] !== "") {
      texCoordIndex = resolveIndex(parseIndexInt(parts[1]), texCoordCount);
    }
    if (parts[2] === "") throw objError("OBJ_FACE_INVALID"); // "v//" or "v/vt/" with nothing after
    normalIndex = resolveIndex(parseIndexInt(parts[2]), normalCount);
  }

  return { vertexIndex, texCoordIndex, normalIndex };
}
