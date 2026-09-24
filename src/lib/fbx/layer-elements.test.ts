import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { readIntegerLayerElement, readLayerElementSource, resolveLayerElementValue, resolveMaterialIndex, type FBXLayerElementSource } from "./layer-elements";
import { DEFAULT_FBX_LIMITS } from "./types";
import { buildFBXBinary, layerElementMaterialNode, layerElementNode } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

describe("readLayerElementSource — node reading", () => {
  it("reads a Direct-referenced normal layer element", () => {
    const buf = buildFBXBinary({ nodes: [layerElementNode("LayerElementNormal", "ByPolygonVertex", "Direct", "Normals", [0, 0, 1, 0, 1, 0])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const source = readLayerElementSource(doc.nodes[0], "Normals", "NormalsIndex", 3);
    expect(source).toMatchObject({ mappingMode: "ByPolygonVertex", referenceMode: "Direct", componentsPerElement: 3 });
    expect(Array.from(source!.directValues)).toEqual([0, 0, 1, 0, 1, 0]);
  });

  it("reads an IndexToDirect-referenced UV layer element with its index array", () => {
    const buf = buildFBXBinary({
      nodes: [layerElementNode("LayerElementUV", "ByPolygonVertex", "IndexToDirect", "UV", [0, 0, 1, 0, 1, 1], "UVIndex", [0, 1, 2, 0])],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    const source = readLayerElementSource(doc.nodes[0], "UV", "UVIndex", 2);
    expect(source!.indexValues).not.toBeNull();
    expect(Array.from(source!.indexValues!)).toEqual([0, 1, 2, 0]);
  });

  it("normalizes the legacy 'ByVertice' mapping spelling to ByControlPoint", () => {
    const buf = buildFBXBinary({ nodes: [layerElementNode("LayerElementNormal", "ByVertice", "Direct", "Normals", [0, 0, 1])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const source = readLayerElementSource(doc.nodes[0], "Normals", "NormalsIndex", 3);
    expect(source!.mappingMode).toBe("ByControlPoint");
  });

  it("returns null for an unrecognized mapping mode string (still readable — validity is judged at resolve time)", () => {
    const buf = buildFBXBinary({ nodes: [layerElementNode("LayerElementNormal", "ByEdge", "Direct", "Normals", [0, 0, 1])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const source = readLayerElementSource(doc.nodes[0], "Normals", "NormalsIndex", 3);
    expect(source!.mappingMode).toBeNull();
  });
});

function normalSource(overrides: Partial<FBXLayerElementSource> = {}): FBXLayerElementSource {
  return {
    mappingMode: "ByPolygonVertex",
    referenceMode: "Direct",
    directValues: Float64Array.from([0, 0, 1, 0, 1, 0, 1, 0, 0]),
    indexValues: null,
    componentsPerElement: 3,
    ...overrides,
  };
}

describe("resolveLayerElementValue — mapping modes", () => {
  it("ByControlPoint resolves using the control-point index", () => {
    const source = normalSource({ mappingMode: "ByControlPoint" });
    expect(resolveLayerElementValue(source, 1, 99, 0).values).toEqual([0, 1, 0]);
  });

  it("ByPolygonVertex resolves using the corner index", () => {
    const source = normalSource({ mappingMode: "ByPolygonVertex" });
    expect(resolveLayerElementValue(source, 99, 2, 0).values).toEqual([1, 0, 0]);
  });

  it("ByPolygon resolves using the polygon index", () => {
    const source = normalSource({ mappingMode: "ByPolygon" });
    expect(resolveLayerElementValue(source, 99, 99, 1).values).toEqual([0, 1, 0]);
  });

  it("AllSame always resolves to entry 0 (Direct) regardless of corner/polygon", () => {
    const source = normalSource({ mappingMode: "AllSame" });
    expect(resolveLayerElementValue(source, 99, 99, 99).values).toEqual([0, 0, 1]);
  });

  it("IndexToDirect resolves through the index array first", () => {
    const source = normalSource({ mappingMode: "ByPolygonVertex", referenceMode: "IndexToDirect", indexValues: Int32Array.from([2, 0, 1]) });
    expect(resolveLayerElementValue(source, 99, 0, 0).values).toEqual([1, 0, 0]); // corner 0 -> index 2 -> entry [1,0,0]
  });

  it("reports unsupported-mapping-mode for an unrecognized mode", () => {
    const source = normalSource({ mappingMode: null });
    expect(resolveLayerElementValue(source, 0, 0, 0)).toEqual({ values: null, failure: "unsupported-mapping-mode" });
  });

  it("reports unsupported-reference-mode for an unrecognized reference mode", () => {
    const source = normalSource({ referenceMode: null });
    expect(resolveLayerElementValue(source, 0, 0, 0)).toEqual({ values: null, failure: "unsupported-reference-mode" });
  });

  it("reports invalid-index for an out-of-range IndexToDirect index array key", () => {
    const source = normalSource({ referenceMode: "IndexToDirect", indexValues: Int32Array.from([0]) });
    expect(resolveLayerElementValue(source, 0, 5, 0)).toEqual({ values: null, failure: "invalid-index" });
  });

  it("reports invalid-index for a direct index pointing outside the direct-value array", () => {
    const source = normalSource({ referenceMode: "IndexToDirect", indexValues: Int32Array.from([999]) });
    expect(resolveLayerElementValue(source, 0, 0, 0)).toEqual({ values: null, failure: "invalid-index" });
  });

  it("resolves UV (2 components) and color (4 components) the same way as normals (3 components)", () => {
    const uv: FBXLayerElementSource = { mappingMode: "ByPolygonVertex", referenceMode: "Direct", directValues: Float64Array.from([0.1, 0.2, 0.3, 0.4]), indexValues: null, componentsPerElement: 2 };
    expect(resolveLayerElementValue(uv, 0, 1, 0).values).toEqual([0.3, 0.4]);

    const color: FBXLayerElementSource = { mappingMode: "ByPolygonVertex", referenceMode: "Direct", directValues: Float64Array.from([1, 0, 0, 1, 0, 1, 0, 1]), indexValues: null, componentsPerElement: 4 };
    expect(resolveLayerElementValue(color, 0, 1, 0).values).toEqual([0, 1, 0, 1]);
  });
});

describe("resolveMaterialIndex", () => {
  it("resolves AllSame to a single material for every polygon", () => {
    const source = { mappingMode: "AllSame" as const, referenceMode: "IndexToDirect" as const, values: Int32Array.from([3]) };
    expect(resolveMaterialIndex(source, 0).values).toEqual([3]);
    expect(resolveMaterialIndex(source, 50).values).toEqual([3]);
  });

  it("resolves ByPolygon to a per-polygon material index", () => {
    const source = { mappingMode: "ByPolygon" as const, referenceMode: "IndexToDirect" as const, values: Int32Array.from([0, 1, 0, 2]) };
    expect(resolveMaterialIndex(source, 2).values).toEqual([0]);
    expect(resolveMaterialIndex(source, 3).values).toEqual([2]);
  });

  it("reports invalid-index for an out-of-range polygon", () => {
    const source = { mappingMode: "ByPolygon" as const, referenceMode: "IndexToDirect" as const, values: Int32Array.from([0]) };
    expect(resolveMaterialIndex(source, 5).failure).toBe("invalid-index");
  });

  it("reads a LayerElementMaterial node correctly", () => {
    const buf = buildFBXBinary({ nodes: [layerElementMaterialNode("ByPolygon", "IndexToDirect", [0, 1, 0])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const source = readIntegerLayerElement(doc.nodes[0], "Materials");
    expect(source!.mappingMode).toBe("ByPolygon");
    expect(Array.from(source!.values)).toEqual([0, 1, 0]);
  });
});
