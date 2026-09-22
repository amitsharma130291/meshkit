import { describe, expect, it } from "vitest";
import { parseThreeMFModel } from "./model-parser";
import { expectThreeMFError, buildModelXML, simpleTriangleMesh } from "./test-fixtures";
import { DEFAULT_THREEMF_LIMITS } from "./types";
import { ThreeMFParseException } from "./errors";

const limits = DEFAULT_THREEMF_LIMITS;

describe("parseThreeMFModel", () => {
  it("parses one mesh object and a build item referencing it", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const model = parseThreeMFModel(xml, limits);
    expect(model.unit).toBe("millimeter");
    expect(model.objects.size).toBe(1);
    expect(model.buildItems).toHaveLength(1);
    const obj = model.objects.get("1");
    expect(obj?.kind).toBe("mesh");
  });

  it("parses multiple mesh objects", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), simpleTriangleMesh("2")],
      buildItems: [{ objectId: "1" }, { objectId: "2" }],
    });
    const model = parseThreeMFModel(xml, limits);
    expect(model.objects.size).toBe(2);
  });

  it("parses multiple build items", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }, { objectId: "1", transform: "1 0 0 0 1 0 0 0 1 10 0 0" }],
    });
    const model = parseThreeMFModel(xml, limits);
    expect(model.buildItems).toHaveLength(2);
  });

  it("parses a components object referencing a mesh", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 5 0 0" }] },
      ],
      buildItems: [{ objectId: "2" }],
    });
    const model = parseThreeMFModel(xml, limits);
    const obj = model.objects.get("2");
    expect(obj?.kind).toBe("components");
    if (obj?.kind === "components") {
      expect(obj.components).toHaveLength(1);
      expect(obj.components[0].objectId).toBe("1");
    }
  });

  it("parses nested components (component referencing a components object)", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1" }] },
        { id: "3", kind: "components", components: [{ objectId: "2" }] },
      ],
      buildItems: [{ objectId: "3" }],
    });
    const model = parseThreeMFModel(xml, limits);
    expect(model.objects.size).toBe(3);
  });

  it("rejects a duplicate object id", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => parseThreeMFModel(xml, limits), "THREEMF_OBJECT_DUPLICATE");
  });

  it("rejects an invalid (non-finite) vertex coordinate", () => {
    const xml = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="NaN" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    expectThreeMFError(() => parseThreeMFModel(xml, limits), "THREEMF_VERTEX_INVALID");
  });

  it("rejects a triangle index out of range", () => {
    const xml = buildModelXML({
      objects: [{ id: "1", kind: "mesh", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 5]] }],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => parseThreeMFModel(xml, limits), "THREEMF_TRIANGLE_INVALID");
  });

  it("rejects a negative triangle index", () => {
    const xml = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="-1" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    expectThreeMFError(() => parseThreeMFModel(xml, limits), "THREEMF_TRIANGLE_INVALID");
  });

  it("accepts an object with an empty mesh (zero triangles) without throwing at parse time", () => {
    const xml = buildModelXML({ objects: [{ id: "1", kind: "mesh", vertices: [], triangles: [] }], buildItems: [] });
    const model = parseThreeMFModel(xml, limits);
    expect(model.objects.get("1")?.kind).toBe("mesh");
  });

  it("parses an empty build section without throwing (resolve-scene.ts is responsible for rejecting it)", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [] });
    const model = parseThreeMFModel(xml, limits);
    expect(model.buildItems).toHaveLength(0);
  });

  it("accepts scientific-notation coordinates", () => {
    const xml = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="1.5e-3" y="-2.25E2" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const model = parseThreeMFModel(xml, limits);
    const obj = model.objects.get("1");
    if (obj?.kind === "mesh") {
      expect(obj.vertices[0]).toBeCloseTo(0.0015, 6);
      expect(obj.vertices[1]).toBeCloseTo(-225, 6);
    }
  });

  it("tolerates mixed whitespace and newlines", () => {
    const xml =
      `<model\n  unit="millimeter"\n  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
      `<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n` +
      `<vertex x="0" y="0" z="0"/>\n<vertex x="1" y="0" z="0"/>\n<vertex x="0" y="1" z="0"/>\n` +
      `</vertices>\n<triangles>\n<triangle v1="0" v2="1" v3="2"/>\n</triangles>\n</mesh>\n</object>\n</resources>\n` +
      `<build>\n<item objectid="1"/>\n</build>\n</model>`;
    const model = parseThreeMFModel(xml, limits);
    expect(model.objects.size).toBe(1);
  });

  it("tolerates namespace-prefixed elements from unsupported extensions", () => {
    const xml = `<m:model xmlns:m="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><m:resources><m:object id="1" type="model"><m:mesh><m:vertices><m:vertex x="0" y="0" z="0"/><m:vertex x="1" y="0" z="0"/><m:vertex x="0" y="1" z="0"/></m:vertices><m:triangles><m:triangle v1="0" v2="1" v3="2"/></m:triangles></m:mesh></m:object></m:resources><m:build><m:item objectid="1"/></m:build></m:model>`;
    const model = parseThreeMFModel(xml, limits);
    expect(model.objects.size).toBe(1);
    expect(model.buildItems).toHaveLength(1);
  });

  it("rejects malformed XML", () => {
    expect(() => parseThreeMFModel("<model><resources>", limits)).toThrow(ThreeMFParseException);
  });

  it("rejects an unsupported unit", () => {
    const xml = buildModelXML({ unit: "furlong", objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    expectThreeMFError(() => parseThreeMFModel(xml, limits), "THREEMF_UNIT_UNSUPPORTED");
  });

  it("defaults to millimeter when no unit attribute is present", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }], omitUnitAttribute: true });
    const model = parseThreeMFModel(xml, limits);
    expect(model.unit).toBe("millimeter");
  });

  it("records unsupported features (materials/colors/textures/metadata) without failing", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      unsupportedFeatures: ["basematerials", "colorgroup", "texture2d", "metadata"],
    });
    const model = parseThreeMFModel(xml, limits);
    expect(model.unsupportedFeatures.has("basematerials")).toBe(true);
    expect(model.unsupportedFeatures.has("colorgroup")).toBe(true);
    expect(model.unsupportedFeatures.has("texture2d")).toBe(true);
    expect(model.unsupportedFeatures.has("metadata")).toBe(true);
  });
});
