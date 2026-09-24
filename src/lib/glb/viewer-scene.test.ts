import { describe, expect, it } from "vitest";
import { resolveGLBViewerPackage } from "./viewer-scene";
import { buildGLB, expectGLBError, indexedTriangleGLB, packBufferViews, simpleTriangleGLB, u16, u8, f32 } from "./test-fixtures";
import { DEFAULT_GLB_VIEWER_LIMITS, type GLBViewerLimits } from "./viewer-types";

const LIMITS = DEFAULT_GLB_VIEWER_LIMITS;

describe("resolveGLBViewerPackage — basic geometry", () => {
  it("resolves an unindexed triangle", () => {
    const result = resolveGLBViewerPackage(simpleTriangleGLB(), LIMITS);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.sourceUnit).toBe("meter");
  });

  it("resolves an indexed triangle", () => {
    const result = resolveGLBViewerPackage(indexedTriangleGLB(), LIMITS);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.indices.length).toBe(3);
  });

  it("never applies the converter's meters-to-millimeters scale", () => {
    const result = resolveGLBViewerPackage(simpleTriangleGLB(), LIMITS);
    // Fixture uses coordinates in [0,1] — if x1000 were applied, max would be 1000, not 1.
    expect(result.boundsMeters.max[0]).toBeLessThanOrEqual(1);
  });
});

describe("resolveGLBViewerPackage — scene hierarchy", () => {
  it("resolves nested nodes, preserving world placement", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1] }, { mesh: 0, translation: [5, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].nodePath).toEqual([0]);
    expect(result.segments[0].nodeIndex).toBe(1);
    expect(result.boundsMeters.min[0]).toBeCloseTo(5, 5);
    expect(result.boundsMeters.max[0]).toBeCloseTo(6, 5);
  });

  it("resolves mesh instancing: one mesh referenced by two nodes produces two independent segments", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [10, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.segments).toHaveLength(2);
    expect(result.nodeInstanceCount).toBe(2);
    expect(result.meshCount).toBe(1);
    expect(result.segments[1].bounds.min[0]).toBeCloseTo(10, 5);
  });

  it("rejects a node cycle", () => {
    const json = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1] }, { children: [0] }],
      meshes: [],
      accessors: [],
      bufferViews: [],
      buffers: [],
    };
    expectGLBError(() => resolveGLBViewerPackage(buildGLB({ json }), LIMITS), "GLB_NODE_CYCLE");
  });

  it("enforces the scene depth ceiling", () => {
    const limits: GLBViewerLimits = { ...LIMITS, maxSceneDepth: 1 };
    const json = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1] }, { children: [2] }, { mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expectGLBError(() => resolveGLBViewerPackage(buildGLB({ json, bin }), limits), "GLB_NODE_DEPTH_EXCEEDED");
  });

  it("gives each segment a correct, non-overlapping index range", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 1, translation: [10, 0, 0] }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] },
        { primitives: [{ attributes: { POSITION: 1 }, indices: 2, mode: 4 }] },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
        { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 48 },
        { buffer: 0, byteOffset: 84, byteLength: 12 },
      ],
      buffers: [{ byteLength: 96 }],
    };
    const { bin } = packBufferViews([
      { bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
      { bytes: f32([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]) },
      { bytes: u16([0, 1, 2, 1, 3, 2]) },
    ]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.segments[0]).toMatchObject({ indexStart: 0, indexCount: 3 });
    expect(result.segments[1]).toMatchObject({ indexStart: 3, indexCount: 6 });
    expect(result.renderedTriangleCount).toBe(3);
  });
});

describe("resolveGLBViewerPackage — normals and transforms", () => {
  it("computes a smooth fallback normal when NORMAL is absent", () => {
    const result = resolveGLBViewerPackage(simpleTriangleGLB(), LIMITS);
    expect(result.hasSourceNormals).toBe(false);
    const n = result.normals;
    const length = Math.hypot(n[0], n[1], n[2]);
    expect(length).toBeCloseTo(1, 4);
  });

  it("transforms a source normal correctly under a pure rotation", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      // 90 degree rotation around Z: quaternion (0,0,sin45,cos45)
      nodes: [{ mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
      ],
      buffers: [{ byteLength: 72 }],
    };
    const { bin } = packBufferViews([
      { bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
      { bytes: f32([1, 0, 0, 1, 0, 0, 1, 0, 0]) }, // normal pointing +X before rotation
    ]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.hasSourceNormals).toBe(true);
    // A +X normal rotated 90 degrees around Z should point toward +Y.
    expect(result.normals[0]).toBeCloseTo(0, 4);
    expect(result.normals[1]).toBeCloseTo(1, 4);
  });

  it("handles non-uniform scale in the normal transform (not just the naive world matrix)", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [2, 1, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
      ],
      buffers: [{ byteLength: 72 }],
    };
    // A flat quad in the XY plane with a normal pointing +X (perpendicular to scale axis) — under non-uniform
    // scale [2,1,1], the naive (non-inverse-transpose) transform would leave it +X too; the correct inverse-transpose
    // result should also point +X here since scale only affects magnitude along X, not direction of an X-aligned normal — use a diagonal normal instead to actually exercise the difference.
    const { bin } = packBufferViews([
      { bytes: f32([0, 0, 0, 1, 1, 0, 0, 1, 0]) },
      { bytes: f32([Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0]) },
    ]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    // Inverse-transpose of diag(2,1,1) is diag(0.5,1,1) — a (1,1,0)/sqrt2 normal becomes (0.5,1,0), normalized.
    const expectedLen = Math.hypot(0.5, 1, 0);
    expect(result.normals[0]).toBeCloseTo(0.5 / expectedLen, 4);
    expect(result.normals[1]).toBeCloseTo(1 / expectedLen, 4);
  });

  it("preserves correct winding/normal direction under a reflecting transform", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [-1, 1, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]); // CCW when viewed from +Z, normal should point +Z unreflected
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    // After reflecting X, an unflipped triangle would face -Z; the winding-fix should keep the rendered normal at +Z.
    expect(result.normals[2]).toBeCloseTo(1, 4);
  });

  it("includes point/line geometry in the overall bounds even when triangles are also present", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 1, translation: [100, 0, 0] }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] },
        { primitives: [{ attributes: { POSITION: 1 }, mode: 0 }] },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 1, type: "VEC3" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 12 },
      ],
      buffers: [{ byteLength: 48 }],
    };
    const { bin } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }, { bytes: f32([0, 0, 0]) }]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    // The far point (at world x=100) must extend boundsMeters, not just the nearby triangle.
    expect(result.boundsMeters.max[0]).toBeCloseTo(100, 5);
  });
});

describe("resolveGLBViewerPackage — materials and colors", () => {
  it("resolves a base-color factor and detects an unsupported texture map", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4, material: 0 }] }],
      materials: [
        {
          name: "Red",
          pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0.2, roughnessFactor: 0.8 },
          normalTexture: { index: 0 },
        },
      ],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.materials[0].name).toBe("Red");
    expect(result.materials[0].baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(result.materials[0].hasUnsupportedTextureMap).toBe(true);
    expect(result.segments[0].materialIndex).toBe(0);
    expect(result.warnings.some((w) => w.code === "textures-not-rendered")).toBe(true);
  });

  it("falls back to a neutral material for an out-of-range material reference, without failing the file", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4, material: 5 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.segments[0].materialIndex).toBeNull();
    expect(result.warnings.some((w) => w.code === "material-reference-invalid")).toBe(true);
  });

  it("resolves normalized unsigned-byte vertex colors", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, mode: 4 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5121, count: 3, type: "VEC4", normalized: true },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 12 },
      ],
      buffers: [{ byteLength: 48 }],
    };
    const { bin } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }, { bytes: u8([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) }]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.hasVertexColors).toBe(true);
    expect(result.colors0![0]).toBeCloseTo(1, 4);
    expect(result.colors0![1]).toBeCloseTo(0, 4);
  });
});

describe("resolveGLBViewerPackage — points and lines", () => {
  it("renders a points-only primitive", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.renderedPointCount).toBe(3);
    expect(result.pointGeometry).toBeDefined();
    expect(result.segments[0].renderCategory).toBe("points");
  });

  it("expands a line strip into consecutive line segments", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 3 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.renderedLineCount).toBe(2);
    expect(result.lineGeometry!.length).toBe(2 * 6);
  });

  it("closes a line loop back to its first vertex", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 2 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.renderedLineCount).toBe(3); // 2 strip segments + 1 closing segment
  });

  it("renders a file with only points and no triangles", () => {
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
      buffers: [{ byteLength: 24 }],
    };
    const bin = f32([0, 0, 0, 1, 1, 1]);
    const buffer = buildGLB({ json, bin });
    const result = resolveGLBViewerPackage(buffer, LIMITS);
    expect(result.renderedTriangleCount).toBe(0);
    expect(result.renderedPointCount).toBe(2);
  });
});

describe("resolveGLBViewerPackage — lifecycle", () => {
  it("throws GLB_VIEWER_NO_RENDERABLE_GEOMETRY when nothing resolves", () => {
    const json = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{}],
      meshes: [],
      accessors: [],
      bufferViews: [],
      buffers: [],
    };
    expectGLBError(() => resolveGLBViewerPackage(buildGLB({ json }), LIMITS), "GLB_VIEWER_NO_RENDERABLE_GEOMETRY");
  });

  it("rejects unsupported required extensions the same way the converter does", () => {
    const json = {
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_draco_mesh_compression"],
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    const bin = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expectGLBError(() => resolveGLBViewerPackage(buildGLB({ json, bin }), LIMITS), "GLB_DRACO_UNSUPPORTED");
  });
});
