import { describe, expect, it } from "vitest";
import { resolveGLBScene } from "./resolve-scene";
import { expectGLBError } from "./test-fixtures";
import { METERS_TO_MILLIMETERS, type DecodedMesh, type GLBLimits, type GLTFDocument, type GLTFNode } from "./types";
import { DEFAULT_GLB_LIMITS } from "./types";

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

function node(overrides: Partial<GLTFNode> = {}): GLTFNode {
  return { children: [], ...overrides };
}

/** A single triangle at [0,0,0]-[1,0,0]-[0,1,0], one meter per unit, in mesh index 0. */
function triangleMesh(): DecodedMesh {
  return {
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        triangleIndices: Uint32Array.from([0, 1, 2]),
        hasMaterial: false,
        hasTexCoords: false,
        hasVertexColors: false,
        hasMorphTargets: false,
      },
    ],
  };
}

describe("resolveGLBScene — scene selection", () => {
  it("uses the declared default scene", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.triangleCount).toBe(1);
  });

  it("falls back to scene zero when `scene` is omitted", () => {
    const doc = baseDoc({ scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.triangleCount).toBe(1);
  });

  it("falls back to un-referenced root nodes when no scenes array exists", () => {
    const doc = baseDoc({ nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.triangleCount).toBe(1);
  });

  it("supports multiple root nodes", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [node({ mesh: 0 }), node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.triangleCount).toBe(2);
    expect(result.nodeInstanceCount).toBe(2);
  });

  it("displays the selected scene's name when present", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0], name: "MainScene" }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.sceneName).toBe("MainScene");
  });

  it("rejects a missing referenced node", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [5] }], nodes: [] });
    expectGLBError(() => resolveGLBScene(doc, [], LIMITS, 0), "GLB_NODE_INVALID");
  });

  it("rejects when there is nothing to anchor a scene to", () => {
    const doc = baseDoc({ nodes: [] });
    expectGLBError(() => resolveGLBScene(doc, [], LIMITS, 0), "GLB_SCENE_MISSING");
  });
});

describe("resolveGLBScene — node graph traversal", () => {
  it("resolves nested child nodes, applying parent transforms", () => {
    const doc = baseDoc({
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [node({ children: [1], translation: [10, 0, 0] }), node({ mesh: 0, translation: [1, 0, 0] })],
    });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    // Local vertex [0,0,0] -> child translation [1,0,0] -> parent translation [10,0,0] = [11,0,0] meters -> mm.
    expect(result.bounds.min[0]).toBeCloseTo(11 * METERS_TO_MILLIMETERS, 3);
  });

  it("instantiates the same mesh from multiple nodes, preserving each placement", () => {
    const doc = baseDoc({
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [node({ mesh: 0, translation: [0, 0, 0] }), node({ mesh: 0, translation: [100, 0, 0] })],
    });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    expect(result.nodeInstanceCount).toBe(2);
    expect(result.triangleCount).toBe(2);
    expect(result.bounds.max[0]).toBeCloseTo(101 * METERS_TO_MILLIMETERS, 3);
  });

  it("rejects a missing child node reference", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ children: [9] })] });
    expectGLBError(() => resolveGLBScene(doc, [], LIMITS, 0), "GLB_NODE_INVALID");
  });

  it("rejects a missing mesh reference", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 3 })] });
    expectGLBError(() => resolveGLBScene(doc, [], LIMITS, 0), "GLB_NODE_INVALID");
  });

  it("detects a node cycle", () => {
    const doc = baseDoc({
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [node({ children: [1] }), node({ children: [0] })],
    });
    expectGLBError(() => resolveGLBScene(doc, [], LIMITS, 0), "GLB_NODE_CYCLE");
  });

  it("applies a maximum depth", () => {
    const nodes: GLTFNode[] = [];
    for (let i = 0; i < 5; i++) nodes.push(node({ children: i < 4 ? [i + 1] : [] }));
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes });
    const limits: GLBLimits = { ...LIMITS, maxSceneDepth: 2 };
    expectGLBError(() => resolveGLBScene(doc, [], limits, 0), "GLB_NODE_DEPTH_EXCEEDED");
  });

  it("applies a maximum resolved-instance count", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0, 1, 2] }], nodes: [node({ mesh: 0 }), node({ mesh: 0 }), node({ mesh: 0 })] });
    const limits: GLBLimits = { ...LIMITS, maxSceneInstances: 2 };
    expectGLBError(() => resolveGLBScene(doc, [triangleMesh()], limits, 0), "GLB_COMPLEXITY_LIMIT");
  });
});

describe("resolveGLBScene — units", () => {
  it("converts one glTF metre to 1000 output units, applied exactly once", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    // Triangle spans exactly 1 meter along X — bounds must be exactly 1000 units, not 1 and not 1,000,000.
    expect(result.bounds.size[0]).toBeCloseTo(METERS_TO_MILLIMETERS, 3);
  });

  it("preserves axis orientation (no axis swap/rotation applied)", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    // Source triangle has all-zero Z; output Z extent must stay zero (not swapped with Y).
    expect(result.bounds.size[2]).toBeCloseTo(0, 5);
    expect(result.bounds.size[1]).toBeCloseTo(METERS_TO_MILLIMETERS, 3);
  });
});

describe("resolveGLBScene — reflection and degenerate triangles", () => {
  it("corrects winding for a reflected node so the normal still points outward", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0, scale: [-1, 1, 1] })] });
    const identityResult = resolveGLBScene(
      baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] }),
      [triangleMesh()],
      LIMITS,
      0,
    );
    const reflectedResult = resolveGLBScene(doc, [triangleMesh()], LIMITS, 0);
    // The whole point of the winding-swap fix is to CANCEL the flip a
    // mirroring transform would otherwise cause — so once corrected, the
    // reflected triangle's normal sign should match the identity case, not
    // oppose it. (transforms.test.ts's "winding correction after
    // reflection" test verifies the naive, uncorrected case DOES flip.)
    expect(Math.sign(reflectedResult.normals[2])).toBe(Math.sign(identityResult.normals[2]));
  });

  it("skips a zero-area triangle after transformation, counts it, and warns", () => {
    const degenerateMesh: DecodedMesh = {
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), // collinear — zero area
          triangleIndices: Uint32Array.from([0, 1, 2]),
          hasMaterial: false,
          hasTexCoords: false,
          hasVertexColors: false,
          hasMorphTargets: false,
        },
      ],
    };
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [node({ mesh: 0 }), node({ mesh: 1 })] });
    // Mesh 0 is degenerate; mesh 1 (reused triangleMesh) is valid, so the file has *some* real output.
    const result = resolveGLBScene(doc, [degenerateMesh, triangleMesh()], LIMITS, 0);
    expect(result.skippedDegenerateTriangles).toBe(1);
    expect(result.triangleCount).toBe(1);
    expect(result.warnings.some((w) => w.code === "degenerate-triangles-skipped")).toBe(true);
  });

  it("rejects a scene whose only geometry is empty", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const emptyMesh: DecodedMesh = { primitives: [] };
    expectGLBError(() => resolveGLBScene(doc, [emptyMesh], LIMITS, 0), "GLB_EMPTY_GEOMETRY");
  });
});

describe("resolveGLBScene — feature warnings", () => {
  it("warns about materials, textures, vertex colors, animations, skins and morph targets", () => {
    const richMesh: DecodedMesh = {
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          triangleIndices: Uint32Array.from([0, 1, 2]),
          hasMaterial: true,
          hasTexCoords: true,
          hasVertexColors: true,
          hasMorphTargets: true,
        },
      ],
    };
    const doc = baseDoc({
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [node({ mesh: 0 })],
      animationCount: 1,
      skinCount: 1,
    });
    const result = resolveGLBScene(doc, [richMesh], LIMITS, 0);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "materials-not-preserved",
        "textures-not-preserved",
        "vertex-colors-not-preserved",
        "animations-not-preserved",
        "skins-not-preserved",
        "morph-targets-not-preserved",
      ]),
    );
  });

  it("warns when unsupported (point/line) primitives were skipped during decoding", () => {
    const doc = baseDoc({ scene: 0, scenes: [{ nodes: [0] }], nodes: [node({ mesh: 0 })] });
    const result = resolveGLBScene(doc, [triangleMesh()], LIMITS, 1);
    expect(result.warnings.some((w) => w.code === "unsupported-primitives-skipped")).toBe(true);
    expect(result.skippedUnsupportedPrimitives).toBe(1);
  });
});
