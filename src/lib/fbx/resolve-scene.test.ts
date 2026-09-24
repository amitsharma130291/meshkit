import { describe, expect, it } from "vitest";
import { resolveFBXViewerScene } from "./resolve-scene";
import { DEFAULT_FBX_VIEWER_LIMITS, type FBXViewerLimits } from "./viewer-types";
import {
  buildFBXBinary,
  connectionsSection,
  d3,
  geometryNode,
  globalSettingsNode,
  layerElementMaterialNode,
  layerElementNode,
  materialNode,
  objectNode,
  objectsSection,
  ooConnection,
  p70,
  properties70,
  textureNode,
  videoNode,
  type FixtureNode,
} from "./test-fixtures";

const LIMITS = DEFAULT_FBX_VIEWER_LIMITS;

function scene(topLevel: FixtureNode[], limits: FBXViewerLimits = LIMITS) {
  const buf = buildFBXBinary({ nodes: topLevel });
  return resolveFBXViewerScene(buf, limits);
}

function triangleGeometry(id: bigint, name = "TriGeom") {
  return geometryNode(id, name, [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3]);
}

describe("resolveFBXViewerScene — basic rendering", () => {
  it("renders a single Model + Geometry with no declared unit/axis, warning about both", () => {
    const result = scene([
      objectsSection([objectNode("Model", 1n, "Cube", "Mesh"), triangleGeometry(2n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ]);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.positions.length).toBe(9);
    expect(result.axisSystemKnown).toBe(false);
    expect(result.normalizedToMeters).toBe(false);
    expect(result.warnings.some((w) => w.code === "axis-system-unknown")).toBe(true);
    expect(result.warnings.some((w) => w.code === "unit-scale-unknown")).toBe(true);
    // No unit/axis declared -> raw coordinates preserved unscaled.
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("rejects a file with no renderable geometry", () => {
    expect(() => scene([objectsSection([objectNode("Model", 1n, "Empty", "Null")]), connectionsSection([ooConnection(1n, 0n)])])).toThrowError();
  });
});

describe("resolveFBXViewerScene — hierarchy and transforms", () => {
  it("a child Model's world position reflects its parent's translation", () => {
    const result = scene([
      objectsSection([
        objectNode("Model", 1n, "Parent", "Null", [properties70([p70("Lcl Translation", "Lcl Translation", "", "A", d3(10, 0, 0))])]),
        objectNode("Model", 2n, "Child", "Mesh"),
        triangleGeometry(3n),
      ]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n), ooConnection(3n, 2n)]),
    ]);
    // Triangle at [0,0,0],[1,0,0],[0,1,0] shifted by parent's [10,0,0].
    expect(Array.from(result.positions)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
  });

  it("multiple Models sharing one Geometry decode it once but render one instance per Model", () => {
    const result = scene([
      objectsSection([
        objectNode("Model", 1n, "A", "Mesh", [properties70([p70("Lcl Translation", "Lcl Translation", "", "A", d3(0, 0, 0))])]),
        objectNode("Model", 2n, "B", "Mesh", [properties70([p70("Lcl Translation", "Lcl Translation", "", "A", d3(100, 0, 0))])]),
        triangleGeometry(3n),
      ]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n), ooConnection(3n, 1n), ooConnection(3n, 2n)]),
    ]);
    expect(result.geometryCount).toBe(1);
    expect(result.meshInstanceCount).toBe(2);
    expect(result.segments).toHaveLength(2);
    // Instance A at origin, instance B shifted +100 on X.
    const posA = Array.from(result.positions.slice(0, 9));
    const posB = Array.from(result.positions.slice(9, 18));
    expect(posA).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(posB).toEqual([100, 0, 0, 101, 0, 0, 100, 1, 0]);
  });

  it("combined scene bounds span every rendered instance", () => {
    const result = scene([
      objectsSection([
        objectNode("Model", 1n, "A", "Mesh"),
        objectNode("Model", 2n, "B", "Mesh", [properties70([p70("Lcl Translation", "Lcl Translation", "", "A", d3(50, 50, 50))])]),
        triangleGeometry(3n),
      ]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n), ooConnection(3n, 1n), ooConnection(3n, 2n)]),
    ]);
    expect(result.boundsModelUnits.min).toEqual([0, 0, 0]);
    expect(result.boundsModelUnits.max).toEqual([51, 51, 50]);
  });

  it("a reflecting scale corrects triangle winding", () => {
    const normalResult = scene([objectsSection([objectNode("Model", 1n, "A", "Mesh"), triangleGeometry(2n)]), connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)])]);
    const reflectedResult = scene([
      objectsSection([objectNode("Model", 1n, "A", "Mesh", [properties70([p70("Lcl Scaling", "Lcl Scaling", "", "A", [{ type: "D", value: -1 }, { type: "D", value: 1 }, { type: "D", value: 1 }])])]), triangleGeometry(2n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ]);
    // Both should have a consistent outward-facing normal sign despite the mirrored winding — i.e. the normal isn't simply flipped along with the geometry uncorrected.
    const normalZ1 = normalResult.normals[2];
    const normalZ2 = reflectedResult.normals[2];
    expect(Math.sign(normalZ1)).toBe(Math.sign(normalZ2));
  });

  it("geometric transform affects only its own mesh, never a child Model", () => {
    const result = scene([
      objectsSection([
        objectNode("Model", 1n, "Parent", "Mesh", [properties70([p70("GeometricTranslation", "Vector3D", "Vector", "", d3(1000, 0, 0))])]),
        objectNode("Model", 2n, "Child", "Mesh"),
        triangleGeometry(3n),
        triangleGeometry(4n, "ChildGeom"),
      ]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n), ooConnection(3n, 1n), ooConnection(4n, 2n)]),
    ]);
    const parentSeg = result.segments.find((s) => s.modelName === "Parent")!;
    const childSeg = result.segments.find((s) => s.modelName === "Child")!;
    const parentX = result.positions[parentSeg.indexStart * 3];
    const childX = result.positions[childSeg.indexStart * 3];
    expect(parentX).toBeCloseTo(1000, 3); // parent's own mesh shifted by its geometric transform
    expect(childX).toBeCloseTo(0, 3); // child mesh NOT shifted by parent's geometric transform
  });
});

describe("resolveFBXViewerScene — units and axes", () => {
  it("normalizes coordinates to meters when UnitScaleFactor is declared (centimeters -> meters)", () => {
    const result = scene([
      globalSettingsNode([p70("UnitScaleFactor", "double", "Number", "", [{ type: "D", value: 1 }])]), // 1 cm per unit
      objectsSection([objectNode("Model", 1n, "A", "Mesh"), triangleGeometry(2n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ]);
    expect(result.normalizedToMeters).toBe(true);
    // Vertex [1,0,0] in cm becomes 0.01 m.
    expect(result.positions[3]).toBeCloseTo(0.01, 5);
  });

  it("remaps a Z-up axis system into Y-up", () => {
    const result = scene([
      globalSettingsNode([
        p70("UpAxis", "int", "Integer", "", [{ type: "I", value: 2 }]),
        p70("UpAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
        p70("FrontAxis", "int", "Integer", "", [{ type: "I", value: 1 }]),
        p70("FrontAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
        p70("CoordAxis", "int", "Integer", "", [{ type: "I", value: 0 }]),
        p70("CoordAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      ]),
      objectsSection([objectNode("Model", 1n, "A", "Mesh"), geometryNode(2n, "G", [0, 0, 5, 1, 0, 0, 0, 1, 0], [0, 1, -3])]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ]);
    expect(result.axisSystemKnown).toBe(true);
    // The control point with source Z=5 (the declared up axis) should land with target Y=5, Z=0.
    const upVertex = [0, 1, 2].map((i) => [result.positions[i * 3], result.positions[i * 3 + 1], result.positions[i * 3 + 2]]).find((p) => Math.abs(p[1] - 5) < 1e-5);
    expect(upVertex).toBeDefined();
    expect(upVertex![2]).toBeCloseTo(0, 5);
  });
});

describe("resolveFBXViewerScene — layer elements end to end", () => {
  it("resolves ByPolygonVertex/Direct normals, UVs and colors", () => {
    const geom = geometryNode(2n, "G", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3], [
      layerElementNode("LayerElementNormal", "ByPolygonVertex", "Direct", "Normals", [0, 0, 1, 0, 0, 1, 0, 0, 1]),
      layerElementNode("LayerElementUV", "ByPolygonVertex", "Direct", "UV", [0, 0, 1, 0, 0, 1]),
      layerElementNode("LayerElementColor", "ByPolygonVertex", "Direct", "Colors", [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
    ]);
    const result = scene([objectsSection([objectNode("Model", 1n, "A", "Mesh"), geom]), connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)])]);
    expect(result.hasSourceNormals).toBe(true);
    expect(Array.from(result.normals.slice(0, 3))).toEqual([0, 0, 1]);
    expect(result.hasUVs).toBe(true);
    expect(Array.from(result.uvs!.slice(0, 2))).toEqual([0, 0]);
    expect(result.hasVertexColors).toBe(true);
    expect(Array.from(result.colors!.slice(0, 4))).toEqual([1, 0, 0, 1]);
  });

  it("falls back to a computed geometric normal when no LayerElementNormal is present", () => {
    const result = scene([objectsSection([objectNode("Model", 1n, "A", "Mesh"), triangleGeometry(2n)]), connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)])]);
    expect(result.hasSourceNormals).toBe(false);
    expect(result.warnings.some((w) => w.code === "geometric-fallback-normals")).toBe(true);
    // All three corners of the single triangle should have the same computed face normal.
    const n0 = Array.from(result.normals.slice(0, 3));
    const n1 = Array.from(result.normals.slice(3, 6));
    expect(n0.map((v) => Math.round(v * 100))).toEqual(n1.map((v) => Math.round(v * 100)));
  });

  it("assigns per-polygon material indices via LayerElementMaterial", () => {
    const geom = geometryNode(4n, "G", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3], [layerElementMaterialNode("AllSame", "IndexToDirect", [0])]);
    const result = scene([
      objectsSection([objectNode("Model", 1n, "A", "Mesh"), materialNode(2n, "Red", "Lambert", []), materialNode(3n, "Blue", "Lambert", []), geom]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n), ooConnection(3n, 1n), ooConnection(4n, 1n)]),
    ]);
    expect(result.materials).toHaveLength(2);
    expect(result.segments[0].materialIndex).toBe(0); // first connected material
  });
});

describe("resolveFBXViewerScene — materials and embedded textures", () => {
  it("resolves an embedded PNG texture through Model -> Material -> Texture -> Video", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const result = scene([
      objectsSection([objectNode("Model", 1n, "A", "Mesh"), materialNode(2n, "M", "Lambert", []), textureNode(3n, "Tex"), videoNode(4n, "V", png), triangleGeometry(5n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n), ooConnection(3n, 2n), ooConnection(4n, 3n), ooConnection(5n, 1n)]),
    ]);
    expect(result.embeddedTextureCount).toBe(1);
    expect(result.materials[0].embeddedImageIndex).toBe(0);
    expect(result.images[0]!.mimeType).toBe("image/png");
  });

  it("never fetches an external-only texture and reports it as a warning", () => {
    const result = scene([
      objectsSection([objectNode("Model", 1n, "A", "Mesh"), materialNode(2n, "M", "Lambert", []), textureNode(3n, "Tex"), triangleGeometry(4n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n), ooConnection(3n, 2n), ooConnection(4n, 1n)]),
    ]);
    expect(result.embeddedTextureCount).toBe(0);
    expect(result.externalTextureReferenceCount).toBe(1);
    expect(result.warnings.some((w) => w.code === "external-texture-not-fetched")).toBe(true);
  });
});

describe("resolveFBXViewerScene — safety ceilings", () => {
  it("enforces the model-count ceiling", () => {
    const limits: FBXViewerLimits = { ...LIMITS, maxModelCount: 1 };
    expect(() =>
      scene(
        [objectsSection([objectNode("Model", 1n, "A", "Mesh"), objectNode("Model", 2n, "B", "Mesh"), triangleGeometry(3n)]), connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n), ooConnection(3n, 1n)])],
        limits,
      ),
    ).toThrowError();
  });
});
