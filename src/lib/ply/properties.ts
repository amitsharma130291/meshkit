/**
 * Resolves the PLY header's declared schema into the specific properties
 * this converter needs — vertex x/y/z and a face vertex-index list — and
 * classifies every other declared property as a recognized-but-dropped
 * kind (color, normal, texture coordinate) or a genuinely unknown one.
 * Nothing here reads any body data; it only inspects `PLYElement`/
 * `PLYProperty` schema objects already produced by `header.ts`.
 */
import { plyError } from "./errors";
import { isIntegerScalarType } from "./scalar-types";
import type { PLYElement, PLYHeader, PLYListProperty } from "./types";

export const VERTEX_COLOR_NAMES = new Set(["red", "green", "blue", "alpha", "r", "g", "b", "a"]);
export const VERTEX_NORMAL_NAMES = new Set(["nx", "ny", "nz"]);
export const VERTEX_TEXCOORD_NAMES = new Set(["s", "t", "u", "v", "texture_u", "texture_v"]);
const FACE_INDEX_NAMES = new Set(["vertex_indices", "vertex_index"]);

export function findVertexElement(header: PLYHeader): PLYElement {
  const element = header.elements.find((e) => e.name === "vertex");
  if (!element) throw plyError("PLY_VERTEX_ELEMENT_MISSING");
  return element;
}

export interface VertexCoordinateIndices {
  xIndex: number;
  yIndex: number;
  zIndex: number;
}

export function findVertexCoordinates(element: PLYElement): VertexCoordinateIndices {
  const indexOf = (name: string): number => element.properties.findIndex((p) => p.name === name);
  const xIndex = indexOf("x");
  const yIndex = indexOf("y");
  const zIndex = indexOf("z");
  if (xIndex === -1 || yIndex === -1 || zIndex === -1) throw plyError("PLY_VERTEX_COORDINATE_MISSING");

  for (const index of [xIndex, yIndex, zIndex]) {
    if (element.properties[index].kind !== "scalar") throw plyError("PLY_VERTEX_COORDINATE_TYPE_INVALID");
  }
  return { xIndex, yIndex, zIndex };
}

export interface VertexPropertyClassification {
  hasColor: boolean;
  hasNormal: boolean;
  hasTexCoord: boolean;
  unknownPropertyCount: number;
}

/** Classifies every vertex property that ISN'T x/y/z — the coordinate indices are excluded rather than counted as "unknown". */
export function classifyVertexProperties(element: PLYElement, coords: VertexCoordinateIndices): VertexPropertyClassification {
  let hasColor = false;
  let hasNormal = false;
  let hasTexCoord = false;
  let unknownPropertyCount = 0;
  const coordIndices = new Set([coords.xIndex, coords.yIndex, coords.zIndex]);

  element.properties.forEach((property, index) => {
    if (coordIndices.has(index)) return;
    if (VERTEX_COLOR_NAMES.has(property.name)) hasColor = true;
    else if (VERTEX_NORMAL_NAMES.has(property.name)) hasNormal = true;
    else if (VERTEX_TEXCOORD_NAMES.has(property.name)) hasTexCoord = true;
    else unknownPropertyCount++;
  });

  return { hasColor, hasNormal, hasTexCoord, unknownPropertyCount };
}

export function findFaceElement(header: PLYHeader): PLYElement | undefined {
  return header.elements.find((e) => e.name === "face");
}

export interface FaceIndexProperty {
  propertyIndex: number;
  property: PLYListProperty;
}

export function findFaceIndexProperty(element: PLYElement): FaceIndexProperty {
  const candidates: FaceIndexProperty[] = [];
  element.properties.forEach((property, propertyIndex) => {
    if (property.kind === "list" && FACE_INDEX_NAMES.has(property.name)) {
      candidates.push({ propertyIndex, property });
    }
  });

  if (candidates.length === 0) throw plyError("PLY_FACE_INDEX_PROPERTY_MISSING");
  if (candidates.length > 1) throw plyError("PLY_FACE_INDEX_PROPERTY_AMBIGUOUS");

  const [found] = candidates;
  if (!isIntegerScalarType(found.property.itemType)) throw plyError("PLY_FACE_INDEX_TYPE_INVALID");
  return found;
}

/** Every face property other than the resolved vertex-index list — counted, never interpreted. */
export function countUnknownFaceProperties(element: PLYElement): number {
  return element.properties.length - 1;
}

export function countUnknownElements(header: PLYHeader): number {
  return header.elements.filter((e) => e.name !== "vertex" && e.name !== "face").length;
}
