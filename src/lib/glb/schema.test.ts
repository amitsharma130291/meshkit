import { describe, expect, it } from "vitest";
import { parseGLTFSchema } from "./schema";
import { DEFAULT_GLB_LIMITS, type GLBLimits } from "./types";
import { expectGLBError } from "./test-fixtures";

const LIMITS: GLBLimits = DEFAULT_GLB_LIMITS;

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("parseGLTFSchema", () => {
  it("parses a minimal valid document", () => {
    const doc = parseGLTFSchema(jsonBytes({ asset: { version: "2.0" } }), LIMITS);
    expect(doc.asset.version).toBe("2.0");
    expect(doc.scenes).toEqual([]);
    expect(doc.nodes).toEqual([]);
  });

  it("rejects invalid JSON", () => {
    expectGLBError(() => parseGLTFSchema(new TextEncoder().encode("{not json"), LIMITS), "GLB_JSON_INVALID");
  });

  it("rejects a non-object JSON root", () => {
    expectGLBError(() => parseGLTFSchema(jsonBytes([1, 2, 3]), LIMITS), "GLB_JSON_INVALID");
    expectGLBError(() => parseGLTFSchema(jsonBytes("hello"), LIMITS), "GLB_JSON_INVALID");
  });

  it("rejects missing asset", () => {
    expectGLBError(() => parseGLTFSchema(jsonBytes({}), LIMITS), "GLB_ASSET_INVALID");
  });

  it("rejects an incompatible glTF version", () => {
    expectGLBError(() => parseGLTFSchema(jsonBytes({ asset: { version: "1.0" } }), LIMITS), "GLB_ASSET_INVALID");
  });

  it("parses nodes, scenes, meshes, accessors, bufferViews and buffers", () => {
    const doc = parseGLTFSchema(
      jsonBytes({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      }),
      LIMITS,
    );
    expect(doc.scene).toBe(0);
    expect(doc.nodes[0].mesh).toBe(0);
    expect(doc.meshes[0].primitives[0].attributes.POSITION).toBe(0);
    expect(doc.accessors[0].count).toBe(3);
    expect(doc.bufferViews[0].byteLength).toBe(36);
    expect(doc.buffers[0].byteLength).toBe(36);
  });

  it("rejects a node with array indices that are not integers", () => {
    expectGLBError(
      () => parseGLTFSchema(jsonBytes({ asset: { version: "2.0" }, nodes: [{ children: [1.5] }] }), LIMITS),
      "GLB_NODE_INVALID",
    );
  });

  it("enforces configured array-size safety ceilings", () => {
    const limits: GLBLimits = { ...LIMITS, maxNodes: 1 };
    expectGLBError(
      () => parseGLTFSchema(jsonBytes({ asset: { version: "2.0" }, nodes: [{}, {}] }), limits),
      "GLB_COMPLEXITY_LIMIT",
    );
  });

  it("rejects a node declaring both matrix and TRS properties", () => {
    expectGLBError(
      () =>
        parseGLTFSchema(
          jsonBytes({
            asset: { version: "2.0" },
            nodes: [{ matrix: Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)), translation: [1, 2, 3] }],
          }),
          LIMITS,
        ),
      "GLB_NODE_INVALID",
    );
  });

  it("rejects non-finite numeric transform values", () => {
    expectGLBError(
      () =>
        parseGLTFSchema(
          jsonBytes({ asset: { version: "2.0" }, nodes: [{ translation: [1, Number.NaN, 3] }] }),
          LIMITS,
        ),
      "GLB_TRANSFORM_INVALID",
    );
  });

  it("rejects a scene with duplicate root node references", () => {
    expectGLBError(
      () => parseGLTFSchema(jsonBytes({ asset: { version: "2.0" }, scenes: [{ nodes: [0, 0] }], nodes: [{}] }), LIMITS),
      "GLB_NODE_INVALID",
    );
  });

  it("parses extensionsRequired and extensionsUsed", () => {
    const doc = parseGLTFSchema(
      jsonBytes({ asset: { version: "2.0" }, extensionsRequired: ["KHR_foo"], extensionsUsed: ["KHR_foo", "KHR_bar"] }),
      LIMITS,
    );
    expect(doc.extensionsRequired).toEqual(["KHR_foo"]);
    expect(doc.extensionsUsed).toEqual(["KHR_foo", "KHR_bar"]);
  });

  it("detects material usage, animation count and skin count for warning purposes only", () => {
    const doc = parseGLTFSchema(
      jsonBytes({
        asset: { version: "2.0" },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0, mode: 4 }] }],
        animations: [{}],
        skins: [{}],
      }),
      LIMITS,
    );
    expect(doc.materialsUsed).toBe(true);
    expect(doc.animationCount).toBe(1);
    expect(doc.skinCount).toBe(1);
  });
});
