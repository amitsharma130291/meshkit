/**
 * Line-oriented OBJ parser: a single forward pass that resolves vertices,
 * faces (with triangulation) and metadata statements as they're
 * encountered. A single pass (rather than "read all vertices, then read
 * all faces") is what makes negative face indices resolve correctly per
 * the OBJ spec — they're relative to however many vertices/texture
 * coordinates/normals exist AT THAT POINT in the file, not the file's
 * final totals, and OBJ technically permits `v` and `f` statements to be
 * interleaved.
 */
import { objError } from "./errors";
import { iterateLogicalLines, tokenizeLine } from "./tokenizer";
import { parseFaceVertexToken, type FaceVertexRef } from "./indices";
import { triangulatePolygon } from "./triangulate";
import type { OBJLimits } from "./types";

export interface ParsedTriangle {
  a: number;
  b: number;
  c: number;
}

export interface ParsedOBJDocument {
  /** Flat [x,y,z, x,y,z, ...] — one entry per `v` statement, in source order, after any homogeneous-coordinate division. */
  positions: number[];
  /** Triangles produced after triangulating every face, as absolute indices into `positions`. */
  triangles: ParsedTriangle[];
  sourceVertexCount: number;
  sourceFaceCount: number;
  objectCount: number;
  groupCount: number;
  materialLibraryCount: number;
  usedMaterialCount: number;
  ignoredLineCount: number;
  ignoredPointCount: number;
  usesSmoothShading: boolean;
  hasVertexNormals: boolean;
  hasTextureCoordinates: boolean;
  hasVertexColorData: boolean;
  hasNonPlanarFaces: boolean;
}

const FLOAT_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseFloatToken(token: string): number {
  return FLOAT_PATTERN.test(token) ? Number(token) : NaN;
}

/**
 * Parses a `v` statement's numeric fields. OBJ's `v` line has no single
 * canonical arity, so MeshWrench applies a documented, deterministic
 * disambiguation policy rather than guessing:
 *
 *   - 3 fields: `x y z` — used as-is.
 *   - 4 fields: `x y z w` — homogeneous coordinates; `w` must be finite
 *     and non-zero, and x/y/z are divided by it.
 *   - 6 fields: `x y z r g b` — the common (non-standard) vertex-color
 *     extension; the color channels are validated as numbers, then
 *     discarded, since STL has no field for per-vertex color.
 *   - Any other field count (5, or 7+) has no unambiguous OBJ
 *     interpretation — a 7-field line could mean "x y z w r g b" or a
 *     mistyped color line — so it is rejected rather than guessed at.
 */
export function parseVertexStatement(args: string[]): { x: number; y: number; z: number; hasColorExtension: boolean } {
  if (args.length !== 3 && args.length !== 4 && args.length !== 6) {
    throw objError("OBJ_VERTEX_INVALID");
  }

  const numbers = args.map(parseFloatToken);
  for (const value of numbers) {
    if (!Number.isFinite(value)) throw objError("OBJ_VERTEX_INVALID");
  }

  if (numbers.length === 4) {
    const w = numbers[3];
    if (w === 0) throw objError("OBJ_VERTEX_INVALID");
    return { x: numbers[0] / w, y: numbers[1] / w, z: numbers[2] / w, hasColorExtension: false };
  }

  return { x: numbers[0], y: numbers[1], z: numbers[2], hasColorExtension: numbers.length === 6 };
}

export function assertFiniteTriplet(args: string[]): void {
  if (args.length < 3) throw objError("OBJ_VERTEX_INVALID");
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(parseFloatToken(args[i]))) throw objError("OBJ_VERTEX_INVALID");
  }
}

export function assertMagnitude(value: number, limits: OBJLimits): void {
  if (Math.abs(value) > limits.maxCoordinateMagnitude) throw objError("OBJ_VERTEX_INVALID");
}

export function isSmoothingOff(args: string[]): boolean {
  const value = (args[0] ?? "").toLowerCase();
  return value === "off" || value === "0" || value === "";
}

/** Strips a single trailing reference that duplicates the face's first vertex (the common "closed ring" notation, e.g. `f 1 2 3 1`). */
export function dedupeClosingVertex(refs: FaceVertexRef[]): FaceVertexRef[] {
  if (refs.length >= 2 && refs[0].vertexIndex === refs[refs.length - 1].vertexIndex) {
    return refs.slice(0, -1);
  }
  return refs;
}

/** Any OTHER repeated vertex reference collapses the polygon into invalid/degenerate geometry rather than a legitimate shape, so it's rejected outright instead of silently deduplicated. */
export function assertNoCollapsedVertices(refs: FaceVertexRef[]): void {
  const seen = new Set<number>();
  for (const ref of refs) {
    if (seen.has(ref.vertexIndex)) throw objError("OBJ_FACE_INVALID");
    seen.add(ref.vertexIndex);
  }
}

export function parseOBJDocument(text: string, limits: OBJLimits): ParsedOBJDocument {
  const positions: number[] = [];
  const triangles: ParsedTriangle[] = [];

  let texCoordCount = 0;
  let normalCount = 0;
  let sourceFaceCount = 0;
  let objectCount = 0;
  const groupNames = new Set<string>();
  let materialLibraryCount = 0;
  const usedMaterials = new Set<string>();
  let ignoredLineCount = 0;
  let ignoredPointCount = 0;
  let usesSmoothShading = false;
  let hasVertexColorData = false;
  let hasTextureCoordinates = false;
  let hasVertexNormals = false;
  let hasNonPlanarFaces = false;

  for (const logicalLine of iterateLogicalLines(text)) {
    const tokenized = tokenizeLine(logicalLine.raw);
    if (!tokenized) continue;
    const { keyword, args } = tokenized;

    switch (keyword) {
      case "v": {
        const vertexCount = positions.length / 3;
        if (vertexCount >= limits.maxVertexCount) throw objError("OBJ_VERTEX_LIMIT_EXCEEDED");
        const { x, y, z, hasColorExtension } = parseVertexStatement(args);
        assertMagnitude(x, limits);
        assertMagnitude(y, limits);
        assertMagnitude(z, limits);
        if (hasColorExtension) hasVertexColorData = true;
        positions.push(x, y, z);
        break;
      }

      case "vn": {
        assertFiniteTriplet(args);
        hasVertexNormals = true;
        normalCount++;
        break;
      }

      case "vt": {
        if (args.length < 1 || !Number.isFinite(parseFloatToken(args[0]))) throw objError("OBJ_VERTEX_INVALID");
        hasTextureCoordinates = true;
        texCoordCount++;
        break;
      }

      case "f": {
        sourceFaceCount++;
        const vertexCount = positions.length / 3;
        const refs = args.map((token) => parseFaceVertexToken(token, vertexCount, texCoordCount, normalCount));
        const deduped = dedupeClosingVertex(refs);
        if (deduped.length < 3) throw objError("OBJ_FACE_TOO_SMALL");
        if (deduped.length > limits.maxFaceVertexCount) throw objError("OBJ_FACE_VERTEX_LIMIT_EXCEEDED");
        assertNoCollapsedVertices(deduped);

        const localPositions: [number, number, number][] = deduped.map((ref) => {
          const base = ref.vertexIndex * 3;
          const x = positions[base];
          const y = positions[base + 1];
          const z = positions[base + 2];
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            throw objError("OBJ_NON_FINITE_COORDINATE");
          }
          return [x, y, z];
        });

        const { triangles: localTriangles, nonPlanarWarning } = triangulatePolygon(
          localPositions,
          limits.maxTriangulationIterations,
        );
        if (nonPlanarWarning) hasNonPlanarFaces = true;

        for (const [ia, ib, ic] of localTriangles) {
          if (triangles.length >= limits.maxTriangles) throw objError("OBJ_TRIANGLE_LIMIT_EXCEEDED");
          triangles.push({ a: deduped[ia].vertexIndex, b: deduped[ib].vertexIndex, c: deduped[ic].vertexIndex });
        }
        break;
      }

      case "o": {
        objectCount++;
        break;
      }

      case "g": {
        if (args.length === 0) {
          groupNames.add("default");
        } else {
          for (const name of args) groupNames.add(name);
        }
        break;
      }

      case "s": {
        if (!isSmoothingOff(args)) usesSmoothShading = true;
        break;
      }

      case "mtllib": {
        if (args.length > 0) materialLibraryCount++;
        break;
      }

      case "usemtl": {
        if (args[0]) usedMaterials.add(args[0]);
        break;
      }

      case "l": {
        ignoredLineCount++;
        break;
      }

      case "p": {
        ignoredPointCount++;
        break;
      }

      default:
        // Any other keyword (vp, curve/surface statements, unknown
        // extensions, ...) is tracked nowhere and never treated as
        // geometry — see the "Line parser" requirements this satisfies.
        break;
    }
  }

  return {
    positions,
    triangles,
    sourceVertexCount: positions.length / 3,
    sourceFaceCount,
    objectCount,
    groupCount: groupNames.size,
    materialLibraryCount,
    usedMaterialCount: usedMaterials.size,
    ignoredLineCount,
    ignoredPointCount,
    usesSmoothShading,
    hasVertexNormals,
    hasTextureCoordinates,
    hasVertexColorData,
    hasNonPlanarFaces,
  };
}
