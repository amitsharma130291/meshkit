import { describe, expect, it } from "vitest";
import { convertGLBBuffer } from "./convert";
import { DEFAULT_GLB_LIMITS, type GLBLimits } from "./types";
import { buildGLB, buildSimpleMeshGLB, expectGLBError, f32, indexedTriangleGLB, packBufferViews, simpleTriangleGLB } from "./test-fixtures";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { parseBinarySTL } from "../stl/parse-binary";
import { computeBounds } from "../stl/bounds";
import { DEFAULT_STL_LIMITS } from "../stl/types";

const LIMITS: GLBLimits = DEFAULT_GLB_LIMITS;

describe("convertGLBBuffer — end to end", () => {
  it("converts a simple unindexed triangle", () => {
    const result = convertGLBBuffer(simpleTriangleGLB(), LIMITS);
    expect(result.triangleCount).toBe(1);
  });

  it("converts an indexed triangle", () => {
    const result = convertGLBBuffer(indexedTriangleGLB(), LIMITS);
    expect(result.triangleCount).toBe(1);
  });

  it("converts a triangle strip", () => {
    const buffer = buildSimpleMeshGLB({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], mode: 5 });
    const result = convertGLBBuffer(buffer, LIMITS);
    expect(result.triangleCount).toBe(2);
  });

  it("converts a triangle fan", () => {
    const buffer = buildSimpleMeshGLB({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], mode: 6 });
    const result = convertGLBBuffer(buffer, LIMITS);
    expect(result.triangleCount).toBe(2);
  });

  it("converts nested transformed nodes", () => {
    const buffer = buildSimpleMeshGLB({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      nodeTransform: { translation: [2, 0, 0] },
    });
    const result = convertGLBBuffer(buffer, LIMITS);
    expect(result.bounds.min[0]).toBeCloseTo(2000, 3);
  });

  it("rejects a truncated GLB header", () => {
    expectGLBError(() => convertGLBBuffer(new ArrayBuffer(4), LIMITS), "GLB_HEADER_TRUNCATED");
  });

  it("rejects an invalid GLB with a clear, specific error", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" } } }); // no geometry at all
    expectGLBError(() => convertGLBBuffer(buffer, LIMITS), "GLB_SCENE_MISSING");
  });
});

describe("convertGLBBuffer — external resources and compression", () => {
  it("rejects an external buffer URI without ever needing a network call", () => {
    const { bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews,
      buffers: [{ byteLength: 36, uri: "external.bin" }],
    };
    const buffer = buildGLB({ json }); // no BIN chunk at all — buffer is purely external
    expectGLBError(() => convertGLBBuffer(buffer, LIMITS), "GLB_EXTERNAL_BUFFER_UNSUPPORTED");
  });

  it("rejects a file that requires KHR_draco_mesh_compression", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" }, extensionsRequired: ["KHR_draco_mesh_compression"] } });
    expectGLBError(() => convertGLBBuffer(buffer, LIMITS), "GLB_DRACO_UNSUPPORTED");
  });

  it("rejects a file that requires EXT_meshopt_compression", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" }, extensionsRequired: ["EXT_meshopt_compression"] } });
    expectGLBError(() => convertGLBBuffer(buffer, LIMITS), "GLB_MESHOPT_UNSUPPORTED");
  });

  it("rejects a file that requires an unrecognized extension", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" }, extensionsRequired: ["KHR_totally_made_up"] } });
    expectGLBError(() => convertGLBBuffer(buffer, LIMITS), "GLB_EXTENSION_REQUIRED_UNSUPPORTED");
  });

  it("ignores an unknown extension that is merely used, not required, when core geometry is still valid", () => {
    const { bin, bufferViews } = packBufferViews([{ bytes: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
      extensionsUsed: ["KHR_totally_made_up"],
    };
    const result = convertGLBBuffer(buildGLB({ json, bin }), LIMITS);
    expect(result.triangleCount).toBe(1);
  });
});

describe("convertGLBBuffer — binary STL round trip", () => {
  it("round-trips through the shared binary STL serializer and parser with equivalent triangle count and bounds", () => {
    const buffer = buildSimpleMeshGLB({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] });
    const result = convertGLBBuffer(buffer, LIMITS);
    const stlBuffer = serializeBinarySTL({ positions: result.positions, normals: result.normals });
    const parsed = parseBinarySTL(stlBuffer, DEFAULT_STL_LIMITS);

    expect(parsed.triangleCount).toBe(result.triangleCount);
    expect(computeBounds(parsed.positions)).toEqual(result.bounds);
  });

  it("produces deterministic serialization across repeated conversions", () => {
    const buffer = buildSimpleMeshGLB({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] });
    const first = convertGLBBuffer(buffer, LIMITS);
    const second = convertGLBBuffer(buffer, LIMITS);
    const firstStl = new Uint8Array(serializeBinarySTL({ positions: first.positions, normals: first.normals }));
    const secondStl = new Uint8Array(serializeBinarySTL({ positions: second.positions, normals: second.normals }));
    expect(Array.from(firstStl)).toEqual(Array.from(secondStl));
  });
});
