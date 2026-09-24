/**
 * Viewer-specific 3MF model parsing. Not a second XML/ZIP reader: package
 * opening (package.ts), relationship resolution (relationships.ts) and the
 * XML tokenizer itself (xml.ts) are reused completely unchanged. This
 * module runs its own `XMLHandler` over the same `parseXML()` — mirroring
 * exactly how the OBJ Viewer's `viewer-geometry.ts` reuses the OBJ
 * tokenizer/index-resolver/triangulator rather than `parseOBJDocument`'s
 * loop — because `parseThreeMFModel()` (the converter's own parser)
 * intentionally discards everything a viewer needs and a converter never
 * will: object/build-item `name`, per-object and per-triangle color
 * property references (`pid`/`pindex`/`p1`/`p2`/`p3`), the actual contents
 * of `<basematerials>`/`<colorgroup>` resources, `<metadata>` text, and
 * production-extension cross-part references.
 */
import { threeMFError } from "./errors";
import { parseTransform } from "./transforms";
import { parseThreeMFUnit } from "./units";
import { parseXML, type XMLAttributes, type XMLHandler } from "./xml";
import { parseThreeMFColorHex, type ColorGroupEntry, type MaterialEntry, type ThreeMFColorResources } from "./viewer-colors";
import { sanitizeViewerText } from "./viewer-formatting";
import { IDENTITY_TRANSFORM, type ThreeMFTransform } from "./types";
import { DEFAULT_THREEMF_VIEWER_LIMITS, type ThreeMFMetadataEntry, type ThreeMFViewerLimits } from "./viewer-types";
import type { ThreeMFUnit } from "./types";

/** Beam lattices, slice stacks and other extension elements this phase deliberately never renders, tracked by their (namespace-stripped) local element name. */
const UNSUPPORTED_EXTENSION_ELEMENTS: ReadonlySet<string> = new Set([
  "beamlattice",
  "slicestack",
  "slice",
  "keystore",
  "resourcedata",
  "volumetricstack",
  "volumedata",
  "compositematerials",
  "multiproperties",
]);

export interface ViewerTriangleProps {
  pid: string | undefined;
  p1: number | undefined;
  p2: number | undefined;
  p3: number | undefined;
}

export interface ThreeMFViewerMeshObject {
  kind: "mesh";
  id: string;
  name: string | null;
  pid: string | undefined;
  pindex: number | undefined;
  vertices: Float64Array;
  triangleIndices: Uint32Array;
  /** Aligned 1:1 with triangles (triangleIndices.length / 3 entries). */
  triangleProps: ViewerTriangleProps[];
}

export interface ThreeMFViewerComponentRef {
  objectId: string;
  transform: ThreeMFTransform;
  /** True when this <component> carries a production-extension cross-part reference (a `path` attribute) — never followed; resolved as a skipped branch with a warning. */
  crossPart: boolean;
}

export interface ThreeMFViewerComponentsObject {
  kind: "components";
  id: string;
  name: string | null;
  components: ThreeMFViewerComponentRef[];
}

export type ThreeMFViewerObject = ThreeMFViewerMeshObject | ThreeMFViewerComponentsObject;

export interface ThreeMFViewerBuildItem {
  objectId: string;
  transform: ThreeMFTransform;
  name: string | null;
  crossPart: boolean;
}

export interface ThreeMFViewerModel {
  unit: ThreeMFUnit;
  objects: Map<string, ThreeMFViewerObject>;
  buildItems: ThreeMFViewerBuildItem[];
  colorResources: ThreeMFColorResources;
  textureResourceCount: number;
  metadata: ThreeMFMetadataEntry[];
  unsupportedFeatures: Set<string>;
  crossPartReferenceCount: number;
}

interface ObjectBuildState {
  id: string;
  type: "mesh" | "components" | null;
  name: string | null;
  pid: string | undefined;
  pindex: number | undefined;
  vertices: number[];
  triangles: number[];
  triangleProps: ViewerTriangleProps[];
  components: ThreeMFViewerComponentRef[];
}

function parseResourceId(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseIndexAttr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw threeMFError("THREEMF_COLOR_REFERENCE_INVALID");
  return n;
}

function requireIndexAttr(value: string | undefined): number {
  const n = parseIndexAttr(value);
  if (n === undefined) throw threeMFError("THREEMF_COLOR_REFERENCE_INVALID");
  return n;
}

export function parseThreeMFViewerModel(xml: string, limits: ThreeMFViewerLimits = DEFAULT_THREEMF_VIEWER_LIMITS): ThreeMFViewerModel {
  let modelSeen = false;
  let unit: ThreeMFUnit = "millimeter";
  const objects = new Map<string, ThreeMFViewerObject>();
  const buildItems: ThreeMFViewerBuildItem[] = [];
  const basematerials = new Map<string, MaterialEntry[]>();
  const colorgroups = new Map<string, ColorGroupEntry[]>();
  const textureGroupIds = new Set<string>();
  let textureResourceCount = 0;
  const metadata: ThreeMFMetadataEntry[] = [];
  const unsupportedFeatures = new Set<string>();
  let crossPartReferenceCount = 0;
  let metadataBytes = 0;

  let current: ObjectBuildState | null = null;
  let inVertices = false;
  let inTriangles = false;
  let inComponents = false;
  let inBuild = false;

  let currentMaterialGroupId: string | null = null;
  let materialsBuffer: MaterialEntry[] = [];
  let currentColorGroupId: string | null = null;
  let colorsBuffer: ColorGroupEntry[] = [];

  let capturingMetadata = false;
  let metadataName: string | null = null;
  let metadataText = "";

  function trackMetadataBytes(value: string): void {
    metadataBytes += value.length;
    if (metadataBytes > limits.maxMetadataBytes) throw threeMFError("THREEMF_VIEWER_METADATA_LIMIT");
  }

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
          current = {
            id,
            type: null,
            name: attrs.name ? sanitizeViewerText(attrs.name, limits.maxNameLength) : null,
            pid: parseResourceId(attrs.pid),
            pindex: parseIndexAttr(attrs.pindex),
            vertices: [],
            triangles: [],
            triangleProps: [],
            components: [],
          };
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
          current.vertices.push(requireFinite(attrs.x), requireFinite(attrs.y), requireFinite(attrs.z));
          break;
        }
        case "triangles": {
          inTriangles = true;
          break;
        }
        case "triangle": {
          if (!inTriangles || !current) break;
          current.triangles.push(requireNonNegativeInt(attrs.v1), requireNonNegativeInt(attrs.v2), requireNonNegativeInt(attrs.v3));
          if (current.triangles.length / 3 > limits.maxTriangles) {
            throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
          }
          const pid = parseResourceId(attrs.pid);
          if (pid !== undefined) {
            const p1 = requireIndexAttr(attrs.p1);
            const p2 = attrs.p2 !== undefined ? requireIndexAttr(attrs.p2) : p1;
            const p3 = attrs.p3 !== undefined ? requireIndexAttr(attrs.p3) : p1;
            current.triangleProps.push({ pid, p1, p2, p3 });
          } else {
            current.triangleProps.push({ pid: undefined, p1: undefined, p2: undefined, p3: undefined });
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
          const crossPart = attrs.path !== undefined;
          if (crossPart) crossPartReferenceCount++;
          current.components.push({ objectId, transform, crossPart });
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
          const crossPart = attrs.path !== undefined;
          if (crossPart) crossPartReferenceCount++;
          buildItems.push({
            objectId,
            transform,
            name: attrs.partnumber ? sanitizeViewerText(attrs.partnumber, limits.maxNameLength) : null,
            crossPart,
          });
          break;
        }
        case "basematerials": {
          if (attrs.id === undefined) break;
          if (basematerials.size >= limits.maxMaterialGroups) throw threeMFError("THREEMF_VIEWER_MATERIAL_LIMIT");
          currentMaterialGroupId = attrs.id;
          materialsBuffer = [];
          break;
        }
        case "base": {
          if (currentMaterialGroupId === null) break;
          if (materialsBuffer.length >= limits.maxMaterialEntriesPerGroup) throw threeMFError("THREEMF_VIEWER_MATERIAL_LIMIT");
          materialsBuffer.push({
            name: attrs.name ? sanitizeViewerText(attrs.name, limits.maxNameLength) : null,
            color: attrs.displaycolor !== undefined ? parseThreeMFColorHex(attrs.displaycolor) : null,
          });
          break;
        }
        case "colorgroup": {
          if (attrs.id === undefined) break;
          if (colorgroups.size >= limits.maxColorGroups) throw threeMFError("THREEMF_VIEWER_COLOR_LIMIT");
          currentColorGroupId = attrs.id;
          colorsBuffer = [];
          break;
        }
        case "color": {
          if (currentColorGroupId === null) break;
          if (colorsBuffer.length >= limits.maxColorEntriesPerGroup) throw threeMFError("THREEMF_VIEWER_COLOR_LIMIT");
          if (attrs.color === undefined) throw threeMFError("THREEMF_COLOR_REFERENCE_INVALID");
          colorsBuffer.push({ color: parseThreeMFColorHex(attrs.color) });
          break;
        }
        case "texture2d": {
          textureResourceCount++;
          break;
        }
        case "texture2dgroup": {
          if (attrs.id !== undefined) textureGroupIds.add(attrs.id);
          unsupportedFeatures.add("texture2d");
          break;
        }
        case "metadata": {
          capturingMetadata = true;
          metadataName = attrs.name ? sanitizeViewerText(attrs.name, limits.maxNameLength) : null;
          metadataText = "";
          break;
        }
        default: {
          if (UNSUPPORTED_EXTENSION_ELEMENTS.has(localName)) {
            unsupportedFeatures.add(localName);
          }
          break;
        }
      }
    },
    onText(text: string) {
      if (capturingMetadata) metadataText += text;
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
        case "basematerials": {
          if (currentMaterialGroupId !== null) {
            basematerials.set(currentMaterialGroupId, materialsBuffer);
            currentMaterialGroupId = null;
          }
          break;
        }
        case "colorgroup": {
          if (currentColorGroupId !== null) {
            colorgroups.set(currentColorGroupId, colorsBuffer);
            currentColorGroupId = null;
          }
          break;
        }
        case "metadata": {
          if (capturingMetadata) {
            if (metadata.length >= limits.maxMetadataEntries) throw threeMFError("THREEMF_VIEWER_METADATA_LIMIT");
            const name = metadataName ?? "";
            const value = sanitizeViewerText(metadataText, limits.maxMetadataValueLength);
            trackMetadataBytes(name);
            trackMetadataBytes(value);
            metadata.push({ name, value });
            capturingMetadata = false;
            metadataName = null;
            metadataText = "";
          }
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

  if (!modelSeen) throw threeMFError("THREEMF_XML_MALFORMED");

  return {
    unit,
    objects,
    buildItems,
    colorResources: { basematerials, colorgroups, textureGroupIds },
    textureResourceCount,
    metadata,
    unsupportedFeatures,
    crossPartReferenceCount,
  };
}

function finalizeObject(state: ObjectBuildState, objects: Map<string, ThreeMFViewerObject>): void {
  if (state.type === "mesh") {
    const vertexCount = state.vertices.length / 3;
    for (const index of state.triangles) {
      if (index >= vertexCount) throw threeMFError("THREEMF_TRIANGLE_INVALID");
    }
    objects.set(state.id, {
      kind: "mesh",
      id: state.id,
      name: state.name,
      pid: state.pid,
      pindex: state.pindex,
      vertices: Float64Array.from(state.vertices),
      triangleIndices: Uint32Array.from(state.triangles),
      triangleProps: state.triangleProps,
    });
  } else if (state.type === "components") {
    objects.set(state.id, { kind: "components", id: state.id, name: state.name, components: state.components });
  }
}

function requireFinite(value: string | undefined): number {
  if (value === undefined) throw threeMFError("THREEMF_VERTEX_INVALID");
  const n = Number(value);
  if (!Number.isFinite(n)) throw threeMFError("THREEMF_VERTEX_INVALID");
  return n;
}

function requireNonNegativeInt(value: string | undefined): number {
  if (value === undefined) throw threeMFError("THREEMF_TRIANGLE_INVALID");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw threeMFError("THREEMF_TRIANGLE_INVALID");
  return n;
}
