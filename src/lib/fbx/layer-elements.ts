/**
 * A single, shared resolver for FBX's mapping-mode / reference-mode
 * layer-element scheme — used identically for normals, UVs, vertex
 * colors and per-polygon material indices, rather than four
 * near-duplicate ad hoc readers. FBX names a value's granularity
 * (mapping mode: per control point, per polygon corner, per polygon, or
 * one value for everything) completely independently of how that value
 * is stored (reference mode: inline, or via a separate index array) —
 * this module is the one place those two independent axes are combined
 * into "which direct-array slot does THIS corner actually use."
 *
 * A bad index or an unrecognized mode combination never throws: it
 * resolves to `null` for that one corner (the caller falls back —
 * a computed geometric normal, an absent color, material index 0 — per
 * this phase's own "produce a bounded warning and fall back only where a
 * deterministic fallback exists" policy) and reports which failure
 * class it was, so the caller can emit one bounded, file-level warning
 * rather than one per bad corner.
 */
import { findChild } from "./document";
import type { FBXNode } from "./types";

export type FBXMappingMode = "ByControlPoint" | "ByPolygonVertex" | "ByPolygon" | "AllSame";
export type FBXReferenceMode = "Direct" | "IndexToDirect";

function normalizeMappingMode(raw: string | null): FBXMappingMode | null {
  if (raw === "ByControlPoint" || raw === "ByVertice") return "ByControlPoint"; // "ByVertice" is a documented legacy spelling
  if (raw === "ByPolygonVertex") return "ByPolygonVertex";
  if (raw === "ByPolygon") return "ByPolygon";
  if (raw === "AllSame") return "AllSame";
  return null;
}

function normalizeReferenceMode(raw: string | null): FBXReferenceMode | null {
  if (raw === "Direct") return "Direct";
  if (raw === "IndexToDirect") return "IndexToDirect";
  return null;
}

export interface FBXLayerElementSource {
  mappingMode: FBXMappingMode | null;
  referenceMode: FBXReferenceMode | null;
  /** Flat, `componentsPerElement` values per direct entry. */
  directValues: Float64Array;
  /** Only meaningful (and only present) when `referenceMode === "IndexToDirect"`. */
  indexValues: Int32Array | null;
  componentsPerElement: number;
}

function stringProp(node: FBXNode, index: number): string | null {
  const p = node.properties[index];
  return p && p.type === "S" ? p.value : null;
}

/** Reads a LayerElement* node's own mapping/reference declarations plus one named direct-value child (and, when present, its matching `<Name>Index` child). Doesn't validate array lengths — `resolveLayerElementValue` bounds-checks every actual read. */
export function readLayerElementSource(node: FBXNode, valueChildName: string, indexChildName: string, componentsPerElement: number): FBXLayerElementSource | null {
  const mappingNode = findChild(node, "MappingInformationType");
  const referenceNode = findChild(node, "ReferenceInformationType");
  const valuesNode = findChild(node, valueChildName);
  if (!mappingNode || !referenceNode || !valuesNode) return null;

  const mappingMode = normalizeMappingMode(stringProp(mappingNode, 0));
  const referenceMode = normalizeReferenceMode(stringProp(referenceNode, 0));
  const valuesProp = valuesNode.properties[0];
  if (!valuesProp || valuesProp.type !== "d") return null;

  let indexValues: Int32Array | null = null;
  if (referenceMode === "IndexToDirect") {
    const indexNode = findChild(node, indexChildName);
    const indexProp = indexNode?.properties[0];
    if (indexProp && indexProp.type === "i") indexValues = indexProp.value;
  }

  return { mappingMode, referenceMode, directValues: valuesProp.value, indexValues, componentsPerElement };
}

/** Same shape as `readLayerElementSource`, but for an integer-valued layer element (`LayerElementMaterial`'s `Materials` array) — reference mode is still resolved the same way, but there's no float direct-array to bounds-check against a component count. */
export function readIntegerLayerElement(node: FBXNode, valueChildName: string): { mappingMode: FBXMappingMode | null; referenceMode: FBXReferenceMode | null; values: Int32Array } | null {
  const mappingNode = findChild(node, "MappingInformationType");
  const referenceNode = findChild(node, "ReferenceInformationType");
  const valuesNode = findChild(node, valueChildName);
  if (!mappingNode || !valuesNode) return null;
  const valuesProp = valuesNode.properties[0];
  if (!valuesProp || valuesProp.type !== "i") return null;

  return {
    mappingMode: normalizeMappingMode(stringProp(mappingNode, 0)),
    referenceMode: referenceNode ? normalizeReferenceMode(stringProp(referenceNode, 0)) : null,
    values: valuesProp.value,
  };
}

export type FBXLayerElementFailure = "unsupported-mapping-mode" | "unsupported-reference-mode" | "invalid-index";

export interface FBXLayerElementResolution {
  values: number[] | null;
  failure: FBXLayerElementFailure | null;
}

/** Resolves one corner's value out of a layer-element source. `controlPointIndex`/`cornerIndex`/`polygonIndex` are the three possible granularities a mapping mode might key on — the caller always has all three available from `FBXTriangleRef`. */
export function resolveLayerElementValue(source: FBXLayerElementSource, controlPointIndex: number, cornerIndex: number, polygonIndex: number): FBXLayerElementResolution {
  if (source.mappingMode === null) return { values: null, failure: "unsupported-mapping-mode" };
  if (source.referenceMode === null) return { values: null, failure: "unsupported-reference-mode" };

  let directIndex: number;
  if (source.referenceMode === "Direct") {
    directIndex = source.mappingMode === "ByControlPoint" ? controlPointIndex : source.mappingMode === "ByPolygonVertex" ? cornerIndex : source.mappingMode === "ByPolygon" ? polygonIndex : 0;
  } else {
    const key = source.mappingMode === "ByControlPoint" ? controlPointIndex : source.mappingMode === "ByPolygonVertex" ? cornerIndex : source.mappingMode === "ByPolygon" ? polygonIndex : 0;
    if (!source.indexValues || key < 0 || key >= source.indexValues.length) return { values: null, failure: "invalid-index" };
    directIndex = source.indexValues[key];
  }

  const start = directIndex * source.componentsPerElement;
  if (!Number.isInteger(directIndex) || directIndex < 0 || start + source.componentsPerElement > source.directValues.length) {
    return { values: null, failure: "invalid-index" };
  }

  const values: number[] = [];
  for (let i = 0; i < source.componentsPerElement; i++) values.push(source.directValues[start + i]);
  return { values, failure: null };
}

/** The material-index variant: resolves to a single integer (an index into the object's own connected Material list) rather than a component vector. */
export function resolveMaterialIndex(
  source: { mappingMode: FBXMappingMode | null; referenceMode: FBXReferenceMode | null; values: Int32Array },
  polygonIndex: number,
): FBXLayerElementResolution {
  if (source.mappingMode === null || (source.mappingMode !== "AllSame" && source.mappingMode !== "ByPolygon")) {
    return { values: null, failure: "unsupported-mapping-mode" };
  }
  const key = source.mappingMode === "AllSame" ? 0 : polygonIndex;
  if (key < 0 || key >= source.values.length) return { values: null, failure: "invalid-index" };
  return { values: [source.values[key]], failure: null };
}
