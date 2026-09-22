import { describe, expect, it } from "vitest";
import { readAccessorRaw, readIndexAccessor, readPositionAccessor, resolveBufferView } from "./accessors";
import { DEFAULT_GLB_LIMITS, type GLBLimits, type GLTFDocument } from "./types";
import { expectGLBError, f32, packBufferViews, u16, u32, u8 } from "./test-fixtures";

const LIMITS: GLBLimits = DEFAULT_GLB_LIMITS;

function baseDoc(overrides: Partial<GLTFDocument> = {}): GLTFDocument {
  return {
    asset: { version: "2.0" },
    scenes: [],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    extensionsRequired: [],
    extensionsUsed: [],
    materialsUsed: false,
    animationCount: 0,
    skinCount: 0,
    ...overrides,
  };
}

describe("resolveBufferView", () => {
  it("resolves a valid embedded buffer view", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([1, 2, 3]) }]);
    const doc = baseDoc({ bufferViews, buffers: [{ byteLength: bin.byteLength }] });
    const result = resolveBufferView(doc, 0, bin);
    expect(result.data.byteLength).toBe(12);
  });

  it("rejects an invalid declared buffer length", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([1, 2, 3]) }]);
    const doc = baseDoc({ bufferViews, buffers: [{ byteLength: bin.byteLength + 1000 }] });
    expectGLBError(() => resolveBufferView(doc, 0, bin), "GLB_BUFFER_INVALID");
  });

  it("rejects an out-of-range buffer view", () => {
    const bin = new Uint8Array(8);
    const doc = baseDoc({ bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 100 }], buffers: [{ byteLength: 8 }] });
    expectGLBError(() => resolveBufferView(doc, 0, bin), "GLB_BUFFER_VIEW_INVALID");
  });

  it("defaults byteOffset to zero", () => {
    const bin = new Uint8Array(8);
    const doc = baseDoc({ bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }], buffers: [{ byteLength: 8 }] });
    const result = resolveBufferView(doc, 0, bin);
    expect(result.data.byteLength).toBe(8);
  });

  it("respects an explicit byteOffset", () => {
    const bin = new Uint8Array(16);
    const doc = baseDoc({ bufferViews: [{ buffer: 0, byteOffset: 8, byteLength: 8 }], buffers: [{ byteLength: 16 }] });
    const result = resolveBufferView(doc, 0, bin);
    expect(result.data.byteLength).toBe(8);
  });

  it("rejects a stride smaller than one element (via readAccessorRaw)", () => {
    const bin = new Uint8Array(24);
    const doc = baseDoc({
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24, byteStride: 4 }],
      buffers: [{ byteLength: 24 }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: "VEC3" }],
    });
    expectGLBError(() => readAccessorRaw(doc, 0, bin, LIMITS), "GLB_BUFFER_VIEW_INVALID");
  });

  it("rejects an overflowing range", () => {
    const bin = new Uint8Array(8);
    const doc = baseDoc({ bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 4294967295 }], buffers: [{ byteLength: 8 }] });
    expectGLBError(() => resolveBufferView(doc, 0, bin), "GLB_BUFFER_VIEW_INVALID");
  });

  it("rejects an external buffer URI", () => {
    const bin = new Uint8Array(8);
    const doc = baseDoc({
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
      buffers: [{ byteLength: 8, uri: "external.bin" }],
    });
    expectGLBError(() => resolveBufferView(doc, 0, bin), "GLB_EXTERNAL_BUFFER_UNSUPPORTED");
  });

  it("rejects when the bin chunk is missing", () => {
    const doc = baseDoc({ bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }], buffers: [{ byteLength: 8 }] });
    expectGLBError(() => resolveBufferView(doc, 0, null), "GLB_BIN_CHUNK_MISSING");
  });
});

describe("readPositionAccessor / readIndexAccessor", () => {
  it("reads tightly packed float VEC3 positions", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }],
    });
    const positions = readPositionAccessor(doc, 0, bin, LIMITS);
    expect(Array.from(positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("reads interleaved positions via byteStride", () => {
    // Interleave position (12 bytes) + a fake normal (12 bytes) per vertex.
    const stride = 24;
    const raw = new Uint8Array(stride * 2);
    const view = new DataView(raw.buffer);
    view.setFloat32(0, 1, true);
    view.setFloat32(4, 2, true);
    view.setFloat32(8, 3, true);
    view.setFloat32(stride, 4, true);
    view.setFloat32(stride + 4, 5, true);
    view.setFloat32(stride + 8, 6, true);
    const { bin, bufferViews } = packBufferViews([{ bytes: raw, byteStride: stride }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: "VEC3" }],
    });
    const positions = readPositionAccessor(doc, 0, bin, LIMITS);
    expect(Array.from(positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads unsigned-byte, unsigned-short and unsigned-int indices", () => {
    for (const [bytesFn, componentType] of [
      [u8, 5121],
      [u16, 5123],
      [u32, 5125],
    ] as const) {
      const { bin, bufferViews } = packBufferViews([{ bytes: bytesFn([0, 1, 2]) }]);
      const doc = baseDoc({
        bufferViews,
        buffers: [{ byteLength: bin.byteLength }],
        accessors: [{ bufferView: 0, byteOffset: 0, componentType, count: 3, type: "SCALAR" }],
      });
      expect(Array.from(readIndexAccessor(doc, 0, bin, LIMITS))).toEqual([0, 1, 2]);
    }
  });

  it("rejects a signed-short index component type", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u16([0, 1, 2]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5122, count: 3, type: "SCALAR" }],
    });
    expectGLBError(() => readIndexAccessor(doc, 0, bin, LIMITS), "GLB_INDEX_INVALID");
  });

  it("rejects a float index component type", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 1, 2]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "SCALAR" }],
    });
    expectGLBError(() => readIndexAccessor(doc, 0, bin, LIMITS), "GLB_INDEX_INVALID");
  });

  it("rejects an invalid accessor component type", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 9999, count: 1, type: "VEC3" }],
    });
    expectGLBError(() => readAccessorRaw(doc, 0, bin, LIMITS), "GLB_ACCESSOR_TYPE_UNSUPPORTED");
  });

  it("rejects an invalid accessor type string", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 1, type: "TENSOR9" }],
    });
    expectGLBError(() => readAccessorRaw(doc, 0, bin, LIMITS), "GLB_ACCESSOR_TYPE_UNSUPPORTED");
  });

  it("rejects a misaligned accessor byteOffset", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 1, 1]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 1, componentType: 5126, count: 1, type: "VEC3" }],
    });
    expectGLBError(() => readAccessorRaw(doc, 0, bin, LIMITS), "GLB_ACCESSOR_INVALID");
  });

  it("rejects accessor data extending out of range", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 10, type: "VEC3" }],
    });
    expectGLBError(() => readAccessorRaw(doc, 0, bin, LIMITS), "GLB_ACCESSOR_OUT_OF_BOUNDS");
  });

  it("rejects position accessors that aren't floating-point VEC3 (no KHR_mesh_quantization support)", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u16([0, 0, 0, 1, 1, 1]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5123, count: 2, type: "VEC3" }],
    });
    expectGLBError(() => readPositionAccessor(doc, 0, bin, LIMITS), "GLB_ACCESSOR_TYPE_UNSUPPORTED");
  });

  it("shares one accessor across two references without re-reading corrupted state", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }],
    });
    const first = readPositionAccessor(doc, 0, bin, LIMITS);
    const second = readPositionAccessor(doc, 0, bin, LIMITS);
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});

describe("sparse accessors", () => {
  it("supports a sparse accessor with no base buffer view (implicit zero base)", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u32([1]) }, { bytes: f32([9, 9, 9]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [
        {
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: { count: 1, indices: { bufferView: 0, byteOffset: 0, componentType: 5125 }, values: { bufferView: 1, byteOffset: 0 } },
        },
      ],
    });
    const positions = readPositionAccessor(doc, 0, bin, LIMITS);
    // vertex 0 = [0,0,0] (default), vertex 1 (sparse index 1) = [9,9,9], vertex 2 = [0,0,0]
    expect(Array.from(positions)).toEqual([0, 0, 0, 9, 9, 9, 0, 0, 0]);
  });

  it("applies a sparse override on top of a base accessor", () => {
    const { bin, bufferViews } = packBufferViews([
      { bytes: f32([1, 1, 1, 2, 2, 2, 3, 3, 3]) },
      { bytes: u32([2]) },
      { bytes: f32([7, 7, 7]) },
    ]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: { count: 1, indices: { bufferView: 1, byteOffset: 0, componentType: 5125 }, values: { bufferView: 2, byteOffset: 0 } },
        },
      ],
    });
    const positions = readPositionAccessor(doc, 0, bin, LIMITS);
    expect(Array.from(positions)).toEqual([1, 1, 1, 2, 2, 2, 7, 7, 7]);
  });

  it("rejects an out-of-range sparse index", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u32([99]) }, { bytes: f32([1, 1, 1]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [
        {
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: { count: 1, indices: { bufferView: 0, byteOffset: 0, componentType: 5125 }, values: { bufferView: 1, byteOffset: 0 } },
        },
      ],
    });
    expectGLBError(() => readPositionAccessor(doc, 0, bin, LIMITS), "GLB_SPARSE_ACCESSOR_INVALID");
  });

  it("rejects a duplicate sparse index", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u32([0, 0]) }, { bytes: f32([1, 1, 1, 2, 2, 2]) }]);
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [
        {
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: { count: 2, indices: { bufferView: 0, byteOffset: 0, componentType: 5125 }, values: { bufferView: 1, byteOffset: 0 } },
        },
      ],
    });
    expectGLBError(() => readPositionAccessor(doc, 0, bin, LIMITS), "GLB_SPARSE_ACCESSOR_INVALID");
  });

  it("rejects truncated sparse values data", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: u32([0]) }, { bytes: f32([1, 1, 1]) }]);
    // Claim 2 sparse entries but only supply values for 1.
    bufferViews[1].byteLength = 4;
    const doc = baseDoc({
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      accessors: [
        {
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: { count: 2, indices: { bufferView: 0, byteOffset: 0, componentType: 5125 }, values: { bufferView: 1, byteOffset: 0 } },
        },
      ],
    });
    expectGLBError(() => readPositionAccessor(doc, 0, bin, LIMITS), "GLB_SPARSE_ACCESSOR_INVALID");
  });
});
