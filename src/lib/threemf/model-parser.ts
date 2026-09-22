import { threeMFError } from "./errors";
import { parseTransform } from "./transforms";
import { parseThreeMFUnit } from "./units";
import { parseXML, type XMLAttributes, type XMLHandler } from "./xml";
import {
  IDENTITY_TRANSFORM,
  type ThreeMFComponentRef,
  type ThreeMFLimits,
  type ThreeMFModel,
  type ThreeMFObject,
  type ThreeMFUnit,
} from "./types";

const UNSUPPORTED_RESOURCE_ELEMENTS: ReadonlySet<string> = new Set([
  "basematerials",
  "colorgroup",
  "texture2d",
  "metadata",
]);

interface ObjectBuildState {
  id: string;
  type: "mesh" | "components" | null;
  vertices: number[];
  triangles: number[];
  components: ThreeMFComponentRef[];
}

/** Parses one <model> document into its raw (unresolved) objects, build items and declared unit. Scene resolution happens separately in resolve-scene.ts. */
export function parseThreeMFModel(xml: string, limits: ThreeMFLimits): ThreeMFModel {
  let modelSeen = false;
  let unit: ThreeMFUnit = "millimeter";
  const objects = new Map<string, ThreeMFObject>();
  const buildItems: ThreeMFModel["buildItems"] = [];
  const unsupportedFeatures = new Set<string>();

  let current: ObjectBuildState | null = null;
  let inVertices = false;
  let inTriangles = false;
  let inComponents = false;
  let inBuild = false;

  const handler: XMLHandler = {
    onStartElement(localName: string, attrs: XMLAttributes) {
      switch (localName) {
        case "model": {
          modelSeen = true;
          unit = parseThreeMFUnit(attrs.unit);
          break;
        }
        case "object": {
          const id = attrs.id;
          if (!id) throw threeMFError("THREEMF_XML_MALFORMED");
          if (objects.has(id)) throw threeMFError("THREEMF_OBJECT_DUPLICATE");
          current = { id, type: null, vertices: [], triangles: [], components: [] };
          break;
        }
        case "mesh": {
          if (current) current.type = "mesh";
          break;
        }
        case "vertices": {
          inVertices = true;
          break;
        }
        case "vertex": {
          if (!inVertices || !current) break;
          current.vertices.push(
            requireFiniteNumber(attrs.x, "THREEMF_VERTEX_INVALID"),
            requireFiniteNumber(attrs.y, "THREEMF_VERTEX_INVALID"),
            requireFiniteNumber(attrs.z, "THREEMF_VERTEX_INVALID"),
          );
          break;
        }
        case "triangles": {
          inTriangles = true;
          break;
        }
        case "triangle": {
          if (!inTriangles || !current) break;
          current.triangles.push(
            requireNonNegativeInt(attrs.v1),
            requireNonNegativeInt(attrs.v2),
            requireNonNegativeInt(attrs.v3),
          );
          if (current.triangles.length / 3 > limits.maxTriangles) {
            throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
          }
          break;
        }
        case "components": {
          if (current) {
            current.type = "components";
            inComponents = true;
          }
          break;
        }
        case "component": {
          if (!inComponents || !current) break;
          const objectId = attrs.objectid;
          if (!objectId) throw threeMFError("THREEMF_XML_MALFORMED");
          const transform = attrs.transform !== undefined ? parseTransform(attrs.transform) : IDENTITY_TRANSFORM;
          current.components.push({ objectId, transform });
          break;
        }
        case "build": {
          inBuild = true;
          break;
        }
        case "item": {
          if (!inBuild) break;
          const objectId = attrs.objectid;
          if (!objectId) throw threeMFError("THREEMF_XML_MALFORMED");
          const transform = attrs.transform !== undefined ? parseTransform(attrs.transform) : IDENTITY_TRANSFORM;
          buildItems.push({ objectId, transform });
          break;
        }
        default: {
          if (UNSUPPORTED_RESOURCE_ELEMENTS.has(localName)) {
            unsupportedFeatures.add(localName);
          }
          break;
        }
      }
    },
    onEndElement(localName: string) {
      switch (localName) {
        case "vertices":
          inVertices = false;
          break;
        case "triangles":
          inTriangles = false;
          break;
        case "components":
          inComponents = false;
          break;
        case "build":
          inBuild = false;
          break;
        case "object": {
          if (!current) break;
          finalizeObject(current, objects);
          current = null;
          break;
        }
        default:
          break;
      }
    },
  };

  try {
    parseXML(xml, handler);
  } catch (error) {
    if (error instanceof Error && error.name === "ThreeMFParseException") throw error;
    throw threeMFError("THREEMF_XML_MALFORMED");
  }

  if (!modelSeen) {
    throw threeMFError("THREEMF_XML_MALFORMED");
  }

  return { unit, objects, buildItems, unsupportedFeatures };
}

function finalizeObject(state: ObjectBuildState, objects: Map<string, ThreeMFObject>): void {
  if (state.type === "mesh") {
    const vertexCount = state.vertices.length / 3;
    for (const index of state.triangles) {
      if (index >= vertexCount) {
        throw threeMFError("THREEMF_TRIANGLE_INVALID");
      }
    }
    objects.set(state.id, {
      kind: "mesh",
      id: state.id,
      vertices: Float64Array.from(state.vertices),
      triangleIndices: Uint32Array.from(state.triangles),
    });
  } else if (state.type === "components") {
    objects.set(state.id, { kind: "components", id: state.id, components: state.components });
  }
  // An object with neither <mesh> nor <components> is simply not recorded;
  // if something later references its id, resolve-scene.ts reports
  // THREEMF_OBJECT_MISSING rather than this module guessing what it meant.
}

function requireFiniteNumber(value: string | undefined, code: "THREEMF_VERTEX_INVALID"): number {
  if (value === undefined) throw threeMFError(code);
  const n = Number(value);
  if (!Number.isFinite(n)) throw threeMFError(code);
  return n;
}

function requireNonNegativeInt(value: string | undefined): number {
  if (value === undefined) throw threeMFError("THREEMF_TRIANGLE_INVALID");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw threeMFError("THREEMF_TRIANGLE_INVALID");
  return n;
}
