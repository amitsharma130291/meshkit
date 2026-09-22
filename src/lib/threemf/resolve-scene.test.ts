import { describe, expect, it } from "vitest";
import { resolveScene } from "./resolve-scene";
import { parseThreeMFModel } from "./model-parser";
import { expectThreeMFError, buildModelXML, simpleTriangleMesh } from "./test-fixtures";
import { DEFAULT_THREEMF_LIMITS, type ThreeMFLimits } from "./types";

const limits = DEFAULT_THREEMF_LIMITS;

function resolve(xml: string, overrides: Partial<ThreeMFLimits> = {}) {
  const model = parseThreeMFModel(xml, { ...limits, ...overrides });
  return resolveScene(model, { ...limits, ...overrides });
}

describe("resolveScene", () => {
  it("resolves a single mesh object placed by one build item", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const scene = resolve(xml);
    expect(scene.triangleCount).toBe(1);
    expect(scene.objectCount).toBe(1);
    expect(scene.buildItemCount).toBe(1);
    expect(scene.componentInstanceCount).toBe(1);
  });

  it("resolves multiple mesh objects from multiple build items", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), simpleTriangleMesh("2")],
      buildItems: [{ objectId: "1" }, { objectId: "2" }],
    });
    const scene = resolve(xml);
    expect(scene.triangleCount).toBe(2);
    expect(scene.objectCount).toBe(2);
    expect(scene.buildItemCount).toBe(2);
  });

  it("resolves a components object, applying the component's transform", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 100 0 0" }] },
      ],
      buildItems: [{ objectId: "2" }],
    });
    const scene = resolve(xml);
    expect(scene.triangleCount).toBe(1);
    // The mesh's original vertices span x:[0,10]; translated by +100 -> x:[100,110].
    expect(scene.bounds.min[0]).toBeCloseTo(100, 5);
    expect(scene.bounds.max[0]).toBeCloseTo(110, 5);
  });

  it("resolves nested components, composing transforms in the correct order", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"), // spans x:[0,10]
        { id: "2", kind: "components", components: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 10 0 0" }] }, // +10
        { id: "3", kind: "components", components: [{ objectId: "2", transform: "1 0 0 0 1 0 0 0 1 10 0 0" }] }, // +10 again
      ],
      buildItems: [{ objectId: "3" }], // no extra transform
    });
    const scene = resolve(xml);
    // Total translation should be +20 on x: original [0,10] -> [20,30].
    expect(scene.bounds.min[0]).toBeCloseTo(20, 5);
    expect(scene.bounds.max[0]).toBeCloseTo(30, 5);
  });

  it("places multiple instances of the same object at their own build-item transforms", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }, { objectId: "1", transform: "1 0 0 0 1 0 0 0 1 1000 0 0" }],
    });
    const scene = resolve(xml);
    expect(scene.componentInstanceCount).toBe(2);
    expect(scene.objectCount).toBe(1); // same underlying mesh object, instanced twice
    expect(scene.triangleCount).toBe(2);
    expect(scene.bounds.max[0]).toBeGreaterThan(1000); // the second instance is far out on x
  });

  it("rejects a component cycle", () => {
    const xml = buildModelXML({
      objects: [
        { id: "1", kind: "components", components: [{ objectId: "2" }] },
        { id: "2", kind: "components", components: [{ objectId: "1" }] },
      ],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => resolve(xml), "THREEMF_COMPONENT_CYCLE");
  });

  it("rejects component nesting beyond the configured depth limit", () => {
    // Build a chain of components 20 deep, with a depth limit of 5.
    const objects = [];
    for (let i = 0; i < 20; i++) {
      objects.push({ id: String(i), kind: "components" as const, components: [{ objectId: String(i + 1) }] });
    }
    objects.push(simpleTriangleMesh("20"));
    const xml = buildModelXML({ objects, buildItems: [{ objectId: "0" }] });
    expectThreeMFError(() => resolve(xml, { maxComponentDepth: 5 }), "THREEMF_COMPONENT_DEPTH_EXCEEDED");
  });

  it("rejects a build item referencing a missing object", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "999" }] });
    expectThreeMFError(() => resolve(xml), "THREEMF_OBJECT_MISSING");
  });

  it("rejects a component referencing a missing object", () => {
    const xml = buildModelXML({
      objects: [{ id: "1", kind: "components", components: [{ objectId: "999" }] }],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => resolve(xml), "THREEMF_OBJECT_MISSING");
  });

  it("rejects an empty build section", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [] });
    expectThreeMFError(() => resolve(xml), "THREEMF_BUILD_EMPTY");
  });

  it("rejects a scene that resolves to zero triangles", () => {
    const xml = buildModelXML({
      objects: [{ id: "1", kind: "mesh", vertices: [], triangles: [] }],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => resolve(xml), "THREEMF_GEOMETRY_EMPTY");
  });

  it("produces a warning (not an error) for unsupported features when geometry is still valid", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      unsupportedFeatures: ["colorgroup", "basematerials"],
    });
    const scene = resolve(xml);
    expect(scene.triangleCount).toBe(1);
    const codes = scene.warnings.map((w) => w.code);
    expect(codes).toContain("colors-not-preserved");
    expect(codes).toContain("materials-not-preserved");
  });

  it("produces consistent outward-facing winding after a reflecting (mirrored) transform", () => {
    // A mirror on X (determinant -1) applied to a CCW-when-viewed-from+Z triangle.
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"), // vertices (0,0,0),(10,0,0),(0,10,0) — CCW from +Z, normal should point +Z
      ],
      buildItems: [{ objectId: "1", transform: "-1 0 0 0 1 0 0 0 1 0 0 0" }],
    });
    const scene = resolve(xml);
    // Without winding correction, the mirrored triangle's naive cross product would point -Z.
    // With correction (swapping two indices), it should point +Z again, consistent with the
    // pre-mirror orientation as seen from the transform's own handedness.
    expect(scene.normals[2]).toBeCloseTo(1, 5);
  });

  it("computes a consistent normal for a non-reflected (identity) transform as a baseline", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const scene = resolve(xml);
    expect(scene.normals[2]).toBeCloseTo(1, 5);
  });
});
