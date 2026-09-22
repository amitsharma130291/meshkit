/**
 * Generates `3D/3dmodel.model`'s XML text from already-deduplicated,
 * indexed geometry. Unlike the reader side (`xml.ts`'s general SAX
 * tokenizer, needed because incoming 3MF documents have arbitrary
 * structure), this writer emits a fixed, hard-coded schema — one
 * `<object>`, one `<mesh>`, one `<build><item>` — so a general-purpose
 * XML serializer would be overkill. Every element and attribute NAME is
 * a fixed constant; the only values are `formatFloat32()`-formatted
 * numbers (which can never contain an XML-special character) and the
 * single fixed object id, so `escapeXmlAttribute()` is applied defensively
 * rather than because any current value actually needs it.
 */
import { threeMFError } from "./errors";
import { escapeXmlAttribute } from "./xml-escape";
import { formatFloat32 } from "../mesh/number-format";
import { NonFiniteCoordinateError } from "../mesh/errors";
import { yieldIfCancelled } from "../cancellation";
import type { DeduplicatedGeometry } from "../mesh/deduplicate";

const CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
/** Fixed, deterministic — this converter only ever emits one object. Never derived from anything user-controlled. */
const OBJECT_ID = "1";
const DEFAULT_YIELD_EVERY = 100_000;

export interface ModelWriteLimits {
  maxTriangles: number;
}

export interface ModelWriteOptions {
  isCancelled?: () => boolean;
  yieldEvery?: number;
}

function formatCoordinate(value: number): string {
  try {
    return formatFloat32(value);
  } catch (error) {
    if (error instanceof NonFiniteCoordinateError) throw threeMFError("THREEMF_NON_FINITE_OUTPUT");
    throw error;
  }
}

/**
 * Builds the complete model XML document as an array of element strings,
 * joined once at the end — never `+=` concatenation, so this stays
 * linear in output size regardless of mesh size (the same strategy
 * `src/lib/obj/serialize.ts` uses for OBJ text).
 */
export async function writeModelXML(
  geometry: DeduplicatedGeometry,
  limits: ModelWriteLimits,
  options: ModelWriteOptions = {},
): Promise<string> {
  const uniqueVertexCount = geometry.uniqueVertexCount;
  const triangleCount = geometry.triangleVertexIndices.length / 3;

  if (uniqueVertexCount === 0 || triangleCount === 0) {
    throw threeMFError("THREEMF_NO_OUTPUT_GEOMETRY");
  }
  if (triangleCount > limits.maxTriangles) {
    throw threeMFError("THREEMF_TRIANGLE_LIMIT_EXCEEDED");
  }

  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;

  const vertexElements: string[] = new Array(uniqueVertexCount);
  for (let v = 0; v < uniqueVertexCount; v++) {
    await yieldIfCancelled(v, yieldEvery, options.isCancelled);
    const base = v * 3;
    const x = formatCoordinate(geometry.vertices[base]);
    const y = formatCoordinate(geometry.vertices[base + 1]);
    const z = formatCoordinate(geometry.vertices[base + 2]);
    vertexElements[v] = `<vertex x="${x}" y="${y}" z="${z}"/>`;
  }

  const triangleElements: string[] = new Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    await yieldIfCancelled(t, yieldEvery, options.isCancelled);
    const v1 = geometry.triangleVertexIndices[t * 3];
    const v2 = geometry.triangleVertexIndices[t * 3 + 1];
    const v3 = geometry.triangleVertexIndices[t * 3 + 2];
    triangleElements[t] = `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`;
  }

  const objectId = escapeXmlAttribute(OBJECT_ID);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}">`,
    `<resources>`,
    `<object id="${objectId}" type="model">`,
    `<mesh>`,
    `<vertices>${vertexElements.join("")}</vertices>`,
    `<triangles>${triangleElements.join("")}</triangles>`,
    `</mesh>`,
    `</object>`,
    `</resources>`,
    `<build><item objectid="${objectId}"/></build>`,
    `</model>`,
  ].join("");
}
