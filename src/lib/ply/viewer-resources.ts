/**
 * Viewer-specific PLY schema resolution. Not a second header parser: this
 * calls `parsePLYHeader()` and reuses `findVertexElement()`/
 * `findVertexCoordinates()`/`findFaceElement()`/`findFaceIndexProperty()`/
 * `countUnknownFaceProperties()` unchanged — the exact functions
 * `resolvePLYSchema()` (the converter's own schema resolver) uses. The
 * one deliberate divergence: `resolvePLYSchema()` throws
 * `PLY_FACE_ELEMENT_MISSING` when there's no `face` element, since STL
 * can't represent a point cloud; a viewer's whole point is that a
 * point-cloud-only file is a valid, first-class input, so this module's
 * own schema resolver makes the face element optional and additionally
 * resolves vertex color/normal/UV property indices and a conventional
 * `edge` element — none of which the converter's schema ever needed.
 */
import { plyError } from "./errors";
import { parsePLYHeader } from "./header";
import { isIntegerScalarType } from "./scalar-types";
import {
  classifyVertexProperties,
  countUnknownFaceProperties,
  findFaceElement,
  findFaceIndexProperty,
  findVertexCoordinates,
  findVertexElement,
  VERTEX_COLOR_NAMES,
  VERTEX_NORMAL_NAMES,
  VERTEX_TEXCOORD_NAMES,
  type FaceIndexProperty,
  type VertexCoordinateIndices,
} from "./properties";
import type { PLYElement, PLYHeader, PLYLimits, PLYScalarProperty } from "./types";

export interface VertexAttributeIndices {
  colorR: number | null;
  colorG: number | null;
  colorB: number | null;
  colorA: number | null;
  normalX: number | null;
  normalY: number | null;
  normalZ: number | null;
  uvU: number | null;
  uvV: number | null;
}

function indexOfScalar(element: PLYElement, name: string): number | null {
  const index = element.properties.findIndex((p) => p.kind === "scalar" && p.name === name);
  return index === -1 ? null : index;
}

/** Resolves the actual property *indices* behind color/normal/UV — `classifyVertexProperties()` only reports presence, not position. Picks the first complete, unambiguous UV pair in `u/v` → `s/t` → `texture_u/texture_v` priority order; an incomplete pair (only one of the two) is treated as absent rather than guessed. */
export function findVertexAttributeIndices(element: PLYElement): VertexAttributeIndices {
  const colorR = indexOfScalar(element, "red") ?? indexOfScalar(element, "r");
  const colorG = indexOfScalar(element, "green") ?? indexOfScalar(element, "g");
  const colorB = indexOfScalar(element, "blue") ?? indexOfScalar(element, "b");
  const colorA = indexOfScalar(element, "alpha") ?? indexOfScalar(element, "a");

  const normalX = indexOfScalar(element, "nx");
  const normalY = indexOfScalar(element, "ny");
  const normalZ = indexOfScalar(element, "nz");

  const uvPairs: [string, string][] = [
    ["u", "v"],
    ["s", "t"],
    ["texture_u", "texture_v"],
  ];
  let uvU: number | null = null;
  let uvV: number | null = null;
  for (const [uName, vName] of uvPairs) {
    const u = indexOfScalar(element, uName);
    const v = indexOfScalar(element, vName);
    if (u !== null && v !== null) {
      uvU = u;
      uvV = v;
      break;
    }
  }

  return { colorR, colorG, colorB, colorA, normalX, normalY, normalZ, uvU, uvV };
}

export interface PLYViewerEdgeIndices {
  vertex1Index: number;
  vertex2Index: number;
}

export function findEdgeElement(header: PLYHeader): PLYElement | undefined {
  return header.elements.find((e) => e.name === "edge");
}

/** Only the conventional `vertex1`/`vertex2` scalar-integer layout is recognized — per this phase's own "support only documented conventional aliases... unknown layouts produce a warning and are skipped, not guessed" policy. */
export function findEdgeIndexProperties(element: PLYElement): PLYViewerEdgeIndices | null {
  const v1 = indexOfScalar(element, "vertex1");
  const v2 = indexOfScalar(element, "vertex2");
  if (v1 === null || v2 === null) return null;
  if (!isIntegerScalarType((element.properties[v1] as PLYScalarProperty).type)) return null;
  if (!isIntegerScalarType((element.properties[v2] as PLYScalarProperty).type)) return null;
  return { vertex1Index: v1, vertex2Index: v2 };
}

export interface PLYViewerSchema {
  header: PLYHeader;
  bodyOffset: number;
  commentCount: number;
  objInfoCount: number;
  vertexElement: PLYElement;
  coords: VertexCoordinateIndices;
  attrs: VertexAttributeIndices;
  vertexUnknownPropertyCount: number;
  hasTextureCoordinates: boolean;
  faceElement: PLYElement | undefined;
  faceIndexProperty: FaceIndexProperty | null;
  unknownFacePropertyCount: number;
  edgeElement: PLYElement | undefined;
  edgeIndices: PLYViewerEdgeIndices | null;
  hasUnrecognizedEdgeLayout: boolean;
  unknownElementCount: number;
}

export function resolvePLYViewerSchema(buffer: ArrayBuffer, limits: PLYLimits): PLYViewerSchema {
  if (buffer.byteLength > limits.maxFileBytes) throw plyError("PLY_FILE_TOO_LARGE");

  const { header, bodyOffset, commentCount, objInfoCount } = parsePLYHeader(buffer, limits);

  const vertexElement = findVertexElement(header);
  const coords = findVertexCoordinates(vertexElement);
  const classification = classifyVertexProperties(vertexElement, coords);
  if (vertexElement.count > limits.maxVertexCount) throw plyError("PLY_VERTEX_LIMIT_EXCEEDED");
  const attrs = findVertexAttributeIndices(vertexElement);

  const faceElement = findFaceElement(header);
  const faceIndexProperty = faceElement ? findFaceIndexProperty(faceElement) : null;

  const edgeElement = findEdgeElement(header);
  const edgeIndices = edgeElement ? findEdgeIndexProperties(edgeElement) : null;
  const hasUnrecognizedEdgeLayout = edgeElement !== undefined && edgeIndices === null;

  const recognizedNames = new Set(["vertex", "face", "edge"]);
  const unknownElementCount = header.elements.filter((e) => {
    if (!recognizedNames.has(e.name)) return true;
    return e.name === "edge" && hasUnrecognizedEdgeLayout;
  }).length;

  return {
    header,
    bodyOffset,
    commentCount,
    objInfoCount,
    vertexElement,
    coords,
    attrs,
    vertexUnknownPropertyCount: classification.unknownPropertyCount,
    hasTextureCoordinates: attrs.uvU !== null && attrs.uvV !== null,
    faceElement,
    faceIndexProperty,
    unknownFacePropertyCount: faceElement ? countUnknownFaceProperties(faceElement) : 0,
    edgeElement,
    edgeIndices,
    hasUnrecognizedEdgeLayout,
    unknownElementCount,
  };
}

export { VERTEX_COLOR_NAMES, VERTEX_NORMAL_NAMES, VERTEX_TEXCOORD_NAMES };
