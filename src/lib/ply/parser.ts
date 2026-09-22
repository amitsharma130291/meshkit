/**
 * Full-document PLY parsing: header schema resolution, then a single pass
 * over every declared element in header order (the order both binary
 * layout and this reader's own cursor must follow), reading vertex
 * coordinates, triangulating face polygons, and safely skipping anything
 * this converter doesn't use — an unrecognized element entirely, or an
 * unrecognized property alongside ones that are read.
 */
import { plyError } from "./errors";
import { parsePLYHeader } from "./header";
import { tokenizeAsciiBody, createAsciiScalarReader } from "./ascii-reader";
import { createBinaryScalarReader } from "./binary-reader";
import { readListValues, skipProperty, type ScalarReader } from "./scalar-reader";
import { triangulatePolygon } from "./triangulate";
import {
  classifyVertexProperties,
  countUnknownElements,
  countUnknownFaceProperties,
  findFaceElement,
  findFaceIndexProperty,
  findVertexCoordinates,
  findVertexElement,
  type VertexCoordinateIndices,
} from "./properties";
import type { PLYElement, PLYFormat, PLYHeader, PLYLimits, PLYListProperty } from "./types";

export interface ParsedTriangle {
  a: number;
  b: number;
  c: number;
}

export interface ParsedPLYDocument {
  /** Flat [x,y,z, x,y,z, ...] — one entry per vertex row, in source order. */
  positions: number[];
  /** Triangles produced after triangulating every face, as absolute indices into `positions`. */
  triangles: ParsedTriangle[];
  sourceVertexCount: number;
  sourceFaceCount: number;
  vertexPropertyCount: number;
  facePropertyCount: number;
  unknownElementCount: number;
  unknownPropertyCount: number;
  hasVertexColors: boolean;
  hasVertexNormals: boolean;
  hasTextureCoordinates: boolean;
  hasDoublePrecisionSource: boolean;
  hasNonPlanarFaces: boolean;
  format: PLYFormat;
}

function readVertexElement(
  element: PLYElement,
  coords: VertexCoordinateIndices,
  reader: ScalarReader,
  limits: PLYLimits,
  positions: number[],
): boolean {
  let hasDoublePrecisionSource = false;
  const coordIndices = new Set([coords.xIndex, coords.yIndex, coords.zIndex]);

  for (let row = 0; row < element.count; row++) {
    let x = 0;
    let y = 0;
    let z = 0;

    element.properties.forEach((property, index) => {
      if (property.kind === "list") {
        readListValues(property, reader, limits);
        return;
      }
      const value = reader.next(property.type);
      if (index === coords.xIndex) x = value;
      else if (index === coords.yIndex) y = value;
      else if (index === coords.zIndex) z = value;
      if (coordIndices.has(index) && property.type === "float64") hasDoublePrecisionSource = true;
    });

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw plyError("PLY_NON_FINITE_VERTEX");
    positions.push(x, y, z);
  }

  return hasDoublePrecisionSource;
}

function readFaceElement(
  element: PLYElement,
  indexPropertyIndex: number,
  reader: ScalarReader,
  limits: PLYLimits,
  positions: number[],
  triangles: ParsedTriangle[],
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
      triangles.push({ a: faceIndices[ia], b: faceIndices[ib], c: faceIndices[ic] });
    }
  }

  return hasNonPlanarFaces;
}

function skipElement(element: PLYElement, reader: ScalarReader, limits: PLYLimits): void {
  for (let row = 0; row < element.count; row++) {
    for (const property of element.properties) skipProperty(property, reader, limits);
  }
}

export interface PLYSchema {
  header: PLYHeader;
  bodyOffset: number;
  vertexElement: PLYElement;
  coords: VertexCoordinateIndices;
  vertexUnknownPropertyCount: number;
  hasVertexColors: boolean;
  hasVertexNormals: boolean;
  hasTextureCoordinates: boolean;
  faceElement: PLYElement;
  faceIndexPropertyIndex: number;
  unknownFacePropertyCount: number;
  unknownElementCount: number;
}

/**
 * Header parsing plus schema resolution — split from body reading so the
 * worker can report a distinct "validating-schema" progress stage before
 * the (usually much slower) pass over the file's actual vertex/face data
 * begins. Rejects a point-cloud-only file (no usable face data) here,
 * before any body byte is read.
 */
export function resolvePLYSchema(buffer: ArrayBuffer, limits: PLYLimits): PLYSchema {
  if (buffer.byteLength > limits.maxFileBytes) throw plyError("PLY_FILE_TOO_LARGE");

  const { header, bodyOffset } = parsePLYHeader(buffer, limits);

  const vertexElement = findVertexElement(header);
  const coords = findVertexCoordinates(vertexElement);
  const vertexClassification = classifyVertexProperties(vertexElement, coords);
  if (vertexElement.count > limits.maxVertexCount) throw plyError("PLY_VERTEX_LIMIT_EXCEEDED");

  const faceElement = findFaceElement(header);
  if (!faceElement) throw plyError("PLY_FACE_ELEMENT_MISSING");
  const faceIndexProperty = findFaceIndexProperty(faceElement);

  return {
    header,
    bodyOffset,
    vertexElement,
    coords,
    vertexUnknownPropertyCount: vertexClassification.unknownPropertyCount,
    hasVertexColors: vertexClassification.hasColor,
    hasVertexNormals: vertexClassification.hasNormal,
    hasTextureCoordinates: vertexClassification.hasTexCoord,
    faceElement,
    faceIndexPropertyIndex: faceIndexProperty.propertyIndex,
    unknownFacePropertyCount: countUnknownFaceProperties(faceElement),
    unknownElementCount: countUnknownElements(header),
  };
}

/**
 * The single forward pass over every declared element's body data — reads
 * vertex coordinates, triangulates face polygons and safely skips
 * anything unrecognized, in header order. Vertex reading, face reading and
 * face triangulation are one honest, interleaved pass here (triangulating
 * each face immediately after its own indices are read, the same way
 * `src/lib/obj/parser.ts` interleaves face parsing and triangulation) —
 * not three separable stages, so the worker reports them as one.
 */
export function readPLYBody(schema: PLYSchema, buffer: ArrayBuffer, limits: PLYLimits): ParsedPLYDocument {
  const { header, bodyOffset, vertexElement, coords, faceElement, faceIndexPropertyIndex } = schema;

  const reader: ScalarReader =
    header.format === "ascii"
      ? createAsciiScalarReader(tokenizeAsciiBody(buffer, bodyOffset))
      : createBinaryScalarReader(buffer, bodyOffset, header.format === "binary_little_endian");

  const positions: number[] = [];
  const triangles: ParsedTriangle[] = [];
  let hasDoublePrecisionSource = false;
  let hasNonPlanarFaces = false;

  for (const element of header.elements) {
    if (element === vertexElement) {
      hasDoublePrecisionSource = readVertexElement(element, coords, reader, limits, positions);
    } else if (element === faceElement) {
      hasNonPlanarFaces = readFaceElement(element, faceIndexPropertyIndex, reader, limits, positions, triangles);
    } else {
      skipElement(element, reader, limits);
    }
  }

  return {
    positions,
    triangles,
    sourceVertexCount: positions.length / 3,
    sourceFaceCount: faceElement.count,
    vertexPropertyCount: vertexElement.properties.length,
    facePropertyCount: faceElement.properties.length,
    unknownElementCount: schema.unknownElementCount,
    unknownPropertyCount: schema.vertexUnknownPropertyCount + schema.unknownFacePropertyCount,
    hasVertexColors: schema.hasVertexColors,
    hasVertexNormals: schema.hasVertexNormals,
    hasTextureCoordinates: schema.hasTextureCoordinates,
    hasDoublePrecisionSource,
    hasNonPlanarFaces,
    format: header.format,
  };
}

/** Convenience wrapper for callers that don't need the schema/body stages split (tests, and anywhere outside the worker's staged pipeline). */
export function parsePLYDocument(buffer: ArrayBuffer, limits: PLYLimits): ParsedPLYDocument {
  const schema = resolvePLYSchema(buffer, limits);
  return readPLYBody(schema, buffer, limits);
}
