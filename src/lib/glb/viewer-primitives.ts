/**
 * Decodes one primitive's full renderable attribute set — unlike
 * `primitives.ts`'s `decodePrimitive` (which only reads POSITION and
 * indices, since that's all the STL converter can use), the viewer also
 * needs NORMAL, TEXCOORD_0 and COLOR_0 values, tangent/UV/color
 * *presence*, and point/line primitives (which the converter skips
 * outright). Every read goes through the exact same validated primitives
 * the converter uses — `readPositionAccessor`, `readIndexAccessor`,
 * `readAccessorRaw`, `buildTriangleIndices` — this file adds decoding for
 * attribute kinds those functions don't cover, never a second accessor
 * reader.
 */
import { readAccessorRaw, readIndexAccessor, readPositionAccessor } from "./accessors";
import {
  buildTriangleIndices,
  MODE_LINE_LOOP,
  MODE_LINE_STRIP,
  MODE_LINES,
  MODE_POINTS,
  MODE_TRIANGLE_FAN,
  MODE_TRIANGLE_STRIP,
  MODE_TRIANGLES,
} from "./primitives";
import { computeFaceNormal } from "../stl/normals";
import { glbError } from "./errors";
import type { GLTFDocument, GLTFPrimitive } from "./types";
import type { GLBRenderCategory, GLBViewerLimits } from "./viewer-types";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;

export interface DecodedViewerPrimitive {
  /** Local (untransformed) vertex positions, vertexCount*3. */
  positions: Float32Array;
  /** Local smooth normals — source `NORMAL` when valid, otherwise averaged from this primitive's own adjacent faces. Always present, never null. */
  normals: Float32Array;
  hasSourceNormals: boolean;
  texcoords: Float32Array | null;
  colors: Float32Array | null;
  renderCategory: GLBRenderCategory;
  /** Local triangle indices (renderCategory === "triangles"). */
  triangleIndices: Uint32Array<ArrayBufferLike>;
  /** Local line-segment index pairs (renderCategory === "lines"). */
  lineIndices: Uint32Array<ArrayBufferLike>;
  /** Local point indices (renderCategory === "points"). */
  pointIndices: Uint32Array<ArrayBufferLike>;
  hasTangent: boolean;
  tangentCount: number;
  materialIndex: number | null;
  morphTargetCount: number;
}

function decodeNormalizableVec(
  doc: GLTFDocument,
  accessorIndex: number,
  bin: Uint8Array | null,
  limits: GLBViewerLimits,
  normalized: boolean,
  allowedTypes: string[],
): { values: Float32Array; numComponents: number } | null {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor || !allowedTypes.includes(accessor.type)) return null;
  if (accessor.componentType !== FLOAT && accessor.componentType !== UNSIGNED_BYTE && accessor.componentType !== UNSIGNED_SHORT) return null;
  if (accessor.componentType !== FLOAT && !normalized) return null; // an unnormalized integer UV/color has no defined scale

  let raw;
  try {
    raw = readAccessorRaw(doc, accessorIndex, bin, limits);
  } catch {
    return null;
  }

  const scale = accessor.componentType === UNSIGNED_BYTE ? 255 : accessor.componentType === UNSIGNED_SHORT ? 65535 : 1;
  const values = new Float32Array(raw.values.length);
  for (let i = 0; i < raw.values.length; i++) {
    const v = raw.values[i] / scale;
    if (!Number.isFinite(v)) return null;
    values[i] = Math.min(1, Math.max(0, v));
  }
  return { values, numComponents: raw.numComponents };
}

function decodeNormals(doc: GLTFDocument, accessorIndex: number | undefined, bin: Uint8Array | null, limits: GLBViewerLimits, vertexCount: number): Float32Array | null {
  if (accessorIndex === undefined) return null;
  const accessor = doc.accessors[accessorIndex];
  if (!accessor || accessor.type !== "VEC3" || accessor.componentType !== FLOAT) return null;

  let raw;
  try {
    raw = readAccessorRaw(doc, accessorIndex, bin, limits);
  } catch {
    return null;
  }
  if (raw.values.length !== vertexCount * 3) return null;

  const normals = new Float32Array(raw.values.length);
  for (let i = 0; i < raw.values.length; i += 3) {
    const x = raw.values[i];
    const y = raw.values[i + 1];
    const z = raw.values[i + 2];
    const lengthSq = x * x + y * y + z * z;
    if (!Number.isFinite(lengthSq) || lengthSq < 1e-12) return null;
    const inv = 1 / Math.sqrt(lengthSq);
    normals[i] = x * inv;
    normals[i + 1] = y * inv;
    normals[i + 2] = z * inv;
  }
  return normals;
}

/** Averages each vertex's adjacent face normals within this primitive — the smooth fallback used whenever source normals are absent or invalid. */
function computeAveragedNormals(positions: Float32Array, triangleIndices: Uint32Array): Float32Array {
  const vertexCount = positions.length / 3;
  const accum = new Float32Array(vertexCount * 3);

  for (let t = 0; t < triangleIndices.length; t += 3) {
    const ia = triangleIndices[t];
    const ib = triangleIndices[t + 1];
    const ic = triangleIndices[t + 2];
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];
    const [nx, ny, nz] = computeFaceNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (const idx of [ia, ib, ic]) {
      accum[idx * 3] += nx;
      accum[idx * 3 + 1] += ny;
      accum[idx * 3 + 2] += nz;
    }
  }

  const normals = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const x = accum[v * 3];
    const y = accum[v * 3 + 1];
    const z = accum[v * 3 + 2];
    const lengthSq = x * x + y * y + z * z;
    if (lengthSq > 1e-12) {
      const inv = 1 / Math.sqrt(lengthSq);
      normals[v * 3] = x * inv;
      normals[v * 3 + 1] = y * inv;
      normals[v * 3 + 2] = z * inv;
    }
    // A vertex touched by no triangle (shouldn't happen for a valid index list) keeps a zero normal rather than a fabricated direction.
  }
  return normals;
}

function buildLineIndices(mode: number, elementCount: number, getIndex: (i: number) => number, limits: GLBViewerLimits): Uint32Array {
  const lines: number[] = [];
  const pushLine = (a: number, b: number): void => {
    if (lines.length / 2 >= limits.maxLineSegments) throw glbError("GLB_COMPLEXITY_LIMIT");
    lines.push(a, b);
  };

  if (mode === MODE_LINES) {
    for (let i = 0; i + 1 < elementCount; i += 2) pushLine(getIndex(i), getIndex(i + 1));
  } else if (mode === MODE_LINE_STRIP) {
    for (let i = 0; i + 1 < elementCount; i++) pushLine(getIndex(i), getIndex(i + 1));
  } else if (mode === MODE_LINE_LOOP) {
    for (let i = 0; i + 1 < elementCount; i++) pushLine(getIndex(i), getIndex(i + 1));
    if (elementCount > 1) pushLine(getIndex(elementCount - 1), getIndex(0));
  }

  return Uint32Array.from(lines);
}

function buildPointIndices(elementCount: number, getIndex: (i: number) => number, limits: GLBViewerLimits): Uint32Array {
  const points = new Uint32Array(elementCount);
  if (elementCount > limits.maxPoints) throw glbError("GLB_COMPLEXITY_LIMIT");
  for (let i = 0; i < elementCount; i++) points[i] = getIndex(i);
  return points;
}

export function decodeViewerPrimitive(
  doc: GLTFDocument,
  primitive: GLTFPrimitive,
  bin: Uint8Array | null,
  limits: GLBViewerLimits,
  accessorNormalized: boolean[],
): DecodedViewerPrimitive | null {
  if (primitive.attributes.POSITION === undefined) throw glbError("GLB_POSITION_MISSING");

  const positions = readPositionAccessor(doc, primitive.attributes.POSITION, bin, limits);
  const vertexCount = positions.length / 3;

  const indices = primitive.indices !== undefined ? readIndexAccessor(doc, primitive.indices, bin, limits) : null;
  if (indices) {
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= vertexCount) throw glbError("GLB_INDEX_INVALID");
    }
  }
  const elementCount = indices ? indices.length : vertexCount;
  const getIndex = indices ? (i: number): number => indices[i] : (i: number): number => i;

  let renderCategory: GLBRenderCategory;
  let triangleIndices: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  let lineIndices: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  let pointIndices: Uint32Array<ArrayBufferLike> = new Uint32Array(0);

  if (primitive.mode === MODE_TRIANGLES || primitive.mode === MODE_TRIANGLE_STRIP || primitive.mode === MODE_TRIANGLE_FAN) {
    renderCategory = "triangles";
    triangleIndices = buildTriangleIndices(primitive.mode, elementCount, getIndex, limits);
    if (triangleIndices.length === 0) return null;
  } else if (primitive.mode === MODE_LINES || primitive.mode === MODE_LINE_STRIP || primitive.mode === MODE_LINE_LOOP) {
    renderCategory = "lines";
    lineIndices = buildLineIndices(primitive.mode, elementCount, getIndex, limits);
    if (lineIndices.length === 0) return null;
  } else if (primitive.mode === MODE_POINTS) {
    renderCategory = "points";
    pointIndices = buildPointIndices(elementCount, getIndex, limits);
    if (pointIndices.length === 0) return null;
  } else {
    throw glbError("GLB_PRIMITIVE_MODE_UNSUPPORTED");
  }

  let normals = decodeNormals(doc, primitive.attributes.NORMAL, bin, limits, vertexCount);
  const hasSourceNormals = normals !== null;
  if (!normals) {
    normals = renderCategory === "triangles" ? computeAveragedNormals(positions, triangleIndices) : new Float32Array(vertexCount * 3);
  }

  const texCoordAccessor = primitive.attributes.TEXCOORD_0;
  const texcoordDecoded =
    texCoordAccessor !== undefined
      ? decodeNormalizableVec(doc, texCoordAccessor, bin, limits, accessorNormalized[texCoordAccessor] ?? false, ["VEC2"])
      : null;
  const texcoords = texcoordDecoded ? texcoordDecoded.values : null;

  const colorAccessor = primitive.attributes.COLOR_0;
  let colors: Float32Array | null = null;
  if (colorAccessor !== undefined) {
    const decoded = decodeNormalizableVec(doc, colorAccessor, bin, limits, accessorNormalized[colorAccessor] ?? false, ["VEC3", "VEC4"]);
    if (decoded) {
      colors = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        colors[v * 4] = decoded.values[v * decoded.numComponents];
        colors[v * 4 + 1] = decoded.values[v * decoded.numComponents + 1];
        colors[v * 4 + 2] = decoded.values[v * decoded.numComponents + 2];
        colors[v * 4 + 3] = decoded.numComponents === 4 ? decoded.values[v * decoded.numComponents + 3] : 1;
      }
    }
  }

  const tangentAccessorIndex = primitive.attributes.TANGENT;
  let hasTangent = false;
  let tangentCount = 0;
  if (tangentAccessorIndex !== undefined) {
    const accessor = doc.accessors[tangentAccessorIndex];
    if (accessor && accessor.type === "VEC4" && accessor.componentType === FLOAT) {
      hasTangent = true;
      tangentCount = accessor.count;
    }
  }

  return {
    positions,
    normals,
    hasSourceNormals,
    texcoords,
    colors,
    renderCategory,
    triangleIndices,
    lineIndices,
    pointIndices,
    hasTangent,
    tangentCount,
    materialIndex: primitive.material ?? null,
    morphTargetCount: primitive.targets?.length ?? 0,
  };
}
