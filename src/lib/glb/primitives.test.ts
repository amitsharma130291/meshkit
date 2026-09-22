import { describe, expect, it } from "vitest";
import { decodeMeshes } from "./primitives";
import { DEFAULT_GLB_LIMITS, type GLBLimits, type GLTFDocument, type GLTFMesh } from "./types";
import { expectGLBError, f32, packBufferViews, u32 } from "./test-fixtures";

const LIMITS: GLBLimits = DEFAULT_GLB_LIMITS;

function docWithMesh(mesh: GLTFMesh, bufferViews: GLTFDocument["bufferViews"], binByteLength: number): GLTFDocument {
  return {
    asset: { version: "2.0" },
    scenes: [],
    nodes: [],
    meshes: [mesh],
    accessors: [],
    bufferViews,
    buffers: [{ byteLength: binByteLength }],
    extensionsRequired: [],
    extensionsUsed: [],
    materialsUsed: false,
    animationCount: 0,
    skinCount: 0,
  };
}

describe("decodeMeshes — triangles", () => {
  it("converts a TRIANGLES primitive with indices unchanged (preserving index order)", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }, { bytes: u32([0, 1, 2]) }]);
    const accessors = [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, byteOffset: 0, componentType: 5125, count: 3, type: "SCALAR" },
    ];
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }, bufferViews, bin.byteLength);
    doc.accessors = accessors;
    const { meshes } = decodeMeshes(doc, bin, LIMITS);
    expect(Array.from(meshes[0].primitives[0].triangleIndices)).toEqual([0, 1, 2]);
  });

  it("generates sequential topology for unindexed geometry", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }];
    const { meshes } = decodeMeshes(doc, bin, LIMITS);
    expect(Array.from(meshes[0].primitives[0].triangleIndices)).toEqual([0, 1, 2]);
  });

  it("rejects a TRIANGLES element count not divisible by three", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: "VEC3" }];
    expectGLBError(() => decodeMeshes(doc, bin, LIMITS), "GLB_INDEX_INVALID");
  });
});

describe("decodeMeshes — triangle strip", () => {
  it("produces one triangle for every element after the first two, alternating winding", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: "VEC3" }];
    const { meshes } = decodeMeshes(doc, bin, LIMITS);
    const tri = meshes[0].primitives[0].triangleIndices;
    expect(tri.length / 3).toBe(2); // 4 vertices -> 2 triangles
    expect(Array.from(tri.subarray(0, 3))).toEqual([0, 1, 2]);
    expect(Array.from(tri.subarray(3, 6))).toEqual([2, 1, 3]); // alternated winding
  });

  it("produces zero triangles for a too-short strip rather than erroring", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: "VEC3" }];
    const { meshes } = decodeMeshes(doc, bin, LIMITS);
    expect(meshes[0].primitives).toHaveLength(0); // empty primitive contributes nothing
  });
});

describe("decodeMeshes — triangle fan", () => {
  it("uses the first vertex as the fan center and preserves winding", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 6 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: "VEC3" }];
    const { meshes } = decodeMeshes(doc, bin, LIMITS);
    const tri = meshes[0].primitives[0].triangleIndices;
    expect(Array.from(tri)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});

describe("decodeMeshes — unsupported and invalid modes", () => {
  it("skips POINTS/LINES primitives and reports them via the skipped count", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: "VEC3" }];
    const { meshes, skippedUnsupportedPrimitiveCount } = decodeMeshes(doc, bin, LIMITS);
    expect(meshes[0].primitives).toHaveLength(0);
    expect(skippedUnsupportedPrimitiveCount).toBe(1);
  });

  it("converts supported geometry and skips unsupported primitives within the same mesh", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = docWithMesh(
      {
        primitives: [
          { attributes: { POSITION: 0 }, mode: 4 },
          { attributes: { POSITION: 0 }, mode: 1 }, // LINES — skipped
        ],
      },
      bufferViews,
      bin.byteLength,
    );
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }];
    const { meshes, skippedUnsupportedPrimitiveCount } = decodeMeshes(doc, bin, LIMITS);
    expect(meshes[0].primitives).toHaveLength(1);
    expect(skippedUnsupportedPrimitiveCount).toBe(1);
  });

  it("rejects a genuinely invalid (out-of-spec) primitive mode", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, mode: 42 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }];
    expectGLBError(() => decodeMeshes(doc, bin, LIMITS), "GLB_PRIMITIVE_MODE_UNSUPPORTED");
  });

  it("rejects a primitive with no POSITION attribute", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: {}, mode: 4 }] }, bufferViews, bin.byteLength);
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 1, type: "VEC3" }];
    expectGLBError(() => decodeMeshes(doc, bin, LIMITS), "GLB_POSITION_MISSING");
  });

  it("rejects Draco-compressed primitives rather than misreading fallback attributes", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = docWithMesh(
      { primitives: [{ attributes: { POSITION: 0 }, mode: 4, extensions: { KHR_draco_mesh_compression: {} } }] },
      bufferViews,
      bin.byteLength,
    );
    doc.accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }];
    expectGLBError(() => decodeMeshes(doc, bin, LIMITS), "GLB_DRACO_UNSUPPORTED");
  });
});

describe("decodeMeshes — invalid indices", () => {
  it("rejects an out-of-range index", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }, { bytes: u32([0, 1, 99]) }]);
    const doc = docWithMesh({ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }, bufferViews, bin.byteLength);
    doc.accessors = [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, byteOffset: 0, componentType: 5125, count: 3, type: "SCALAR" },
    ];
    expectGLBError(() => decodeMeshes(doc, bin, LIMITS), "GLB_INDEX_INVALID");
  });
});
