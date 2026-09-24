/**
 * Viewer body reading and geometry assembly. Reuses the exact same
 * low-level primitives `readPLYBody()` (the converter's own body reader)
 * uses — `tokenizeAsciiBody`/`createAsciiScalarReader`,
 * `createBinaryScalarReader`, `readListValues`/`skipProperty`,
 * `triangulatePolygon` — in one forward pass over `header.elements`, the
 * same "cursor must consume exactly as many tokens/bytes as the schema
 * declares, even for a property we don't use" discipline the converter's
 * own reader depends on for staying aligned through an unknown element or
 * property. What's new here: color/normal/UV values are actually read
 * (not just detected), a `face` element is optional (a point cloud is a
 * valid, complete result, not an error), and a recognized `edge` element
 * is read into renderable line-segment indices.
 */
import { computeBounds } from "../stl/bounds";
import { computeFaceNormal } from "../stl/normals";
import { plyError } from "./errors";
import { tokenizeAsciiBody, createAsciiScalarReader } from "./ascii-reader";
import { createBinaryScalarReader } from "./binary-reader";
import { readListValues, skipProperty, type ScalarReader } from "./scalar-reader";
import { triangulatePolygon } from "./triangulate";
import type { PLYElement, PLYListProperty, PLYScalarType } from "./types";
import { resolvePLYViewerSchema, type PLYViewerSchema, type VertexAttributeIndices } from "./viewer-resources";
import { DEFAULT_PLY_VIEWER_LIMITS, type PLYViewerLimits, type PLYViewerResult, type PLYViewerWarning, type PLYViewerWarningCode } from "./viewer-types";

const WARNING_MESSAGES: Record<PLYViewerWarningCode, string> = {
  "invalid-normal-fallback": "Some vertex normals in this file are invalid or missing — a computed geometric normal was used for those vertices instead.",
  "invalid-color-clamped": "Some vertex color values in this file were outside their declared type's valid range and were clamped.",
  "unrecognized-edge-layout": "This file includes an edge element, but not in a recognized vertex1/vertex2 layout, so it wasn't rendered.",
  "non-planar-faces": "Some faces in this file aren't perfectly flat — MeshWrench triangulated them with a small tolerance.",
};

function normalizeColorChannel(rawValue: number, type: PLYScalarType, markInvalid: () => void): number {
  let value: number;
  switch (type) {
    case "uint8":
    case "int8":
      value = rawValue / 255;
      break;
    case "uint16":
    case "int16":
      value = rawValue / 65535;
      break;
    case "float32":
    case "float64":
      value = rawValue;
      break;
    default:
      value = rawValue;
      markInvalid();
      break;
  }
  if (!Number.isFinite(value)) {
    markInvalid();
    return 0;
  }
  if (value < 0 || value > 1) {
    markInvalid();
    return Math.min(1, Math.max(0, value));
  }
  return value;
}

function readVertexElement(
  element: PLYElement,
  attrs: VertexAttributeIndices,
  schema: PLYViewerSchema,
  reader: ScalarReader,
  limits: PLYViewerLimits,
  positions: number[],
  colors: number[] | null,
  rawNormals: number[] | null,
  uvs: number[] | null,
  markInvalidColor: () => void,
): void {
  const coordIndices = new Set([schema.coords.xIndex, schema.coords.yIndex, schema.coords.zIndex]);

  for (let row = 0; row < element.count; row++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let r = 1;
    let g = 1;
    let b = 1;
    let a = 1;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let u = 0;
    let v = 0;

    element.properties.forEach((property, index) => {
      if (property.kind === "list") {
        readListValues(property, reader, limits);
        return;
      }
      const value = reader.next(property.type);
      if (index === schema.coords.xIndex) x = value;
      else if (index === schema.coords.yIndex) y = value;
      else if (index === schema.coords.zIndex) z = value;
      else if (colors && index === attrs.colorR) r = normalizeColorChannel(value, property.type, markInvalidColor);
      else if (colors && index === attrs.colorG) g = normalizeColorChannel(value, property.type, markInvalidColor);
      else if (colors && index === attrs.colorB) b = normalizeColorChannel(value, property.type, markInvalidColor);
      else if (colors && index === attrs.colorA) a = normalizeColorChannel(value, property.type, markInvalidColor);
      else if (rawNormals && index === attrs.normalX) nx = value;
      else if (rawNormals && index === attrs.normalY) ny = value;
      else if (rawNormals && index === attrs.normalZ) nz = value;
      else if (uvs && index === attrs.uvU) u = value;
      else if (uvs && index === attrs.uvV) v = value;
      void coordIndices;
    });

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw plyError("PLY_NON_FINITE_VERTEX");
    positions.push(x, y, z);
    if (colors) colors.push(r, g, b, a);
    if (rawNormals) rawNormals.push(nx, ny, nz);
    if (uvs) uvs.push(u, v);
  }
}

function readFaceElement(
  element: PLYElement,
  indexPropertyIndex: number,
  reader: ScalarReader,
  limits: PLYViewerLimits,
  positions: number[],
  triangles: [number, number, number][],
): boolean {
  const vertexCount = positions.length / 3;
  let hasNonPlanarFaces = false;

  for (let row = 0; row < element.count; row++) {
    let faceIndices: number[] = [];

    element.properties.forEach((property, index) => {
      if (index === indexPropertyIndex) {
        faceIndices = readListValues(property as PLYListProperty, reader, limits);
      } else {
        skipProperty(property, reader, limits);
      }
    });

    if (faceIndices.length > limits.maxFaceVertexCount) throw plyError("PLY_FACE_VERTEX_LIMIT_EXCEEDED");
    for (const idx of faceIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) throw plyError("PLY_INDEX_OUT_OF_RANGE");
    }

    const localPositions: [number, number, number][] = faceIndices.map((idx) => {
      const base = idx * 3;
      return [positions[base], positions[base + 1], positions[base + 2]];
    });

    const { triangles: localTriangles, nonPlanarWarning } = triangulatePolygon(localPositions, limits.maxTriangulationIterations);
    if (nonPlanarWarning) hasNonPlanarFaces = true;

    for (const [ia, ib, ic] of localTriangles) {
      if (triangles.length >= limits.maxTriangles) throw plyError("PLY_TRIANGLE_LIMIT_EXCEEDED");
      triangles.push([faceIndices[ia], faceIndices[ib], faceIndices[ic]]);
    }
  }

  return hasNonPlanarFaces;
}

function readEdgeElement(
  element: PLYElement,
  vertex1Index: number,
  vertex2Index: number,
  reader: ScalarReader,
  limits: PLYViewerLimits,
  vertexCount: number,
  edges: number[],
): void {
  for (let row = 0; row < element.count; row++) {
    let v1 = -1;
    let v2 = -1;
    element.properties.forEach((property, index) => {
      if (property.kind === "list") {
        readListValues(property, reader, limits);
        return;
      }
      const value = reader.next(property.type);
      if (index === vertex1Index) v1 = value;
      else if (index === vertex2Index) v2 = value;
    });

    if (!Number.isInteger(v1) || v1 < 0 || v1 >= vertexCount) throw plyError("PLY_INDEX_OUT_OF_RANGE");
    if (!Number.isInteger(v2) || v2 < 0 || v2 >= vertexCount) throw plyError("PLY_INDEX_OUT_OF_RANGE");
    if (edges.length / 2 >= limits.maxEdgeCount) throw plyError("PLY_VIEWER_EDGE_LIMIT");
    edges.push(v1, v2);
  }
}

function skipElement(element: PLYElement, reader: ScalarReader, limits: PLYViewerLimits): void {
  for (let row = 0; row < element.count; row++) {
    for (const property of element.properties) skipProperty(property, reader, limits);
  }
}

/** Averages each vertex's adjacent face normals across the *whole* mesh (PLY has no per-primitive boundary the way GLB does) — the smooth fallback used per-vertex wherever a source normal is absent or invalid. */
function computeSmoothNormals(
  positions: number[],
  triangles: [number, number, number][],
  rawNormals: number[] | null,
): { normals: Float32Array; hasValidSource: boolean; hasInvalidSource: boolean } {
  const vertexCount = positions.length / 3;
  const accum = new Float32Array(vertexCount * 3);

  for (const [a, b, c] of triangles) {
    const [nx, ny, nz] = computeFaceNormal(
      positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
      positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
      positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
    );
    for (const idx of [a, b, c]) {
      accum[idx * 3] += nx;
      accum[idx * 3 + 1] += ny;
      accum[idx * 3 + 2] += nz;
    }
  }

  const normals = new Float32Array(vertexCount * 3);
  let hasValidSource = false;
  let hasInvalidSource = false;

  for (let vtx = 0; vtx < vertexCount; vtx++) {
    let usedRaw = false;
    if (rawNormals) {
      const rx = rawNormals[vtx * 3];
      const ry = rawNormals[vtx * 3 + 1];
      const rz = rawNormals[vtx * 3 + 2];
      const lengthSq = rx * rx + ry * ry + rz * rz;
      if (Number.isFinite(lengthSq) && lengthSq > 1e-12) {
        const inv = 1 / Math.sqrt(lengthSq);
        normals[vtx * 3] = rx * inv;
        normals[vtx * 3 + 1] = ry * inv;
        normals[vtx * 3 + 2] = rz * inv;
        hasValidSource = true;
        usedRaw = true;
      } else {
        hasInvalidSource = true;
      }
    }
    if (!usedRaw) {
      const ax = accum[vtx * 3];
      const ay = accum[vtx * 3 + 1];
      const az = accum[vtx * 3 + 2];
      const lengthSq = ax * ax + ay * ay + az * az;
      if (lengthSq > 1e-12) {
        const inv = 1 / Math.sqrt(lengthSq);
        normals[vtx * 3] = ax * inv;
        normals[vtx * 3 + 1] = ay * inv;
        normals[vtx * 3 + 2] = az * inv;
      }
    }
  }

  return { normals, hasValidSource, hasInvalidSource };
}

function boundsFromIndices(positions: Float32Array, indices: Iterable<number>): STLBoundsResult {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const idx of indices) {
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

type STLBoundsResult = ReturnType<typeof computeBounds>;

export function resolvePLYViewerScene(schema: PLYViewerSchema, buffer: ArrayBuffer, limits: PLYViewerLimits = DEFAULT_PLY_VIEWER_LIMITS): PLYViewerResult {
  const { header, bodyOffset, vertexElement, attrs, faceElement, faceIndexProperty, edgeElement, edgeIndices } = schema;

  const reader: ScalarReader =
    header.format === "ascii"
      ? createAsciiScalarReader(tokenizeAsciiBody(buffer, bodyOffset))
      : createBinaryScalarReader(buffer, bodyOffset, header.format === "binary_little_endian");

  const positions: number[] = [];
  const hasColor = attrs.colorR !== null || attrs.colorG !== null || attrs.colorB !== null;
  const hasAlpha = attrs.colorA !== null;
  const colors: number[] | null = hasColor || hasAlpha ? [] : null;
  const hasNormal = attrs.normalX !== null && attrs.normalY !== null && attrs.normalZ !== null;
  const rawNormals: number[] | null = hasNormal ? [] : null;
  const hasUv = attrs.uvU !== null && attrs.uvV !== null;
  const uvs: number[] | null = hasUv ? [] : null;
  const triangles: [number, number, number][] = [];
  const edges: number[] = [];
  let hasNonPlanarFaces = false;
  let hasInvalidColor = false;

  for (const element of header.elements) {
    if (element === vertexElement) {
      readVertexElement(element, attrs, schema, reader, limits, positions, colors, rawNormals, uvs, () => {
        hasInvalidColor = true;
      });
    } else if (faceElement && element === faceElement && faceIndexProperty) {
      hasNonPlanarFaces = readFaceElement(element, faceIndexProperty.propertyIndex, reader, limits, positions, triangles);
    } else if (edgeElement && element === edgeElement && edgeIndices) {
      readEdgeElement(element, edgeIndices.vertex1Index, edgeIndices.vertex2Index, reader, limits, vertexElement.count, edges);
    } else {
      skipElement(element, reader, limits);
    }
  }

  if (positions.length === 0) throw plyError("PLY_VIEWER_NO_RENDERABLE_GEOMETRY");
  if (positions.length / 3 > limits.maxPointCount) throw plyError("PLY_VIEWER_POINT_LIMIT");

  const positionArray = Float32Array.from(positions);

  let normals: Float32Array | undefined;
  let hasSourceNormals = false;
  let hasInvalidSourceNormal = false;
  if (triangles.length > 0) {
    const smooth = computeSmoothNormals(positions, triangles, rawNormals);
    normals = smooth.normals;
    hasSourceNormals = smooth.hasValidSource;
    hasInvalidSourceNormal = smooth.hasInvalidSource;
  }

  const surfaceIndices = triangles.length > 0 ? Uint32Array.from(triangles.flat()) : undefined;
  const edgeIndexArray = edges.length > 0 ? Uint32Array.from(edges) : undefined;

  const boundsModelUnits = computeBounds(positionArray);
  const boundsSurface = surfaceIndices ? boundsFromIndices(positionArray, surfaceIndices) : undefined;
  const boundsEdges = edgeIndexArray ? boundsFromIndices(positionArray, edgeIndexArray) : undefined;
  const boundsPoints = boundsModelUnits;

  const warnings: PLYViewerWarning[] = [];
  const addWarning = (code: PLYViewerWarningCode): void => {
    warnings.push({ code, message: WARNING_MESSAGES[code] });
  };
  if (hasInvalidSourceNormal) addWarning("invalid-normal-fallback");
  if (hasInvalidColor) addWarning("invalid-color-clamped");
  if (schema.hasUnrecognizedEdgeLayout) addWarning("unrecognized-edge-layout");
  if (hasNonPlanarFaces) addWarning("non-planar-faces");

  return {
    positions: positionArray,
    normals,
    colors: colors ? Float32Array.from(colors) : undefined,
    uvs: uvs ? Float32Array.from(uvs) : undefined,
    surfaceIndices,
    edgeIndices: edgeIndexArray,
    format: header.format,
    sourceVertexCount: vertexElement.count,
    sourceFaceCount: faceElement ? faceElement.count : 0,
    renderedTriangleCount: triangles.length,
    edgeCount: edges.length / 2,
    renderedPointCount: positionArray.length / 3,
    vertexPropertyCount: vertexElement.properties.length,
    facePropertyCount: faceElement ? faceElement.properties.length : 0,
    unknownElementCount: schema.unknownElementCount,
    unknownPropertyCount: schema.vertexUnknownPropertyCount + schema.unknownFacePropertyCount,
    commentCount: schema.commentCount,
    objInfoCount: schema.objInfoCount,
    hasSourceNormals,
    hasVertexColors: hasColor,
    hasAlpha,
    hasTextureCoordinates: hasUv,
    boundsModelUnits,
    boundsSurface,
    boundsEdges,
    boundsPoints,
    warnings,
  };
}

/** Convenience wrapper for callers that don't need the schema/body stages split (tests, and anywhere outside the worker's staged pipeline). */
export function resolvePLYViewerPackage(buffer: ArrayBuffer, limits: PLYViewerLimits = DEFAULT_PLY_VIEWER_LIMITS): PLYViewerResult {
  const schema = resolvePLYViewerSchema(buffer, limits);
  return resolvePLYViewerScene(schema, buffer, limits);
}
