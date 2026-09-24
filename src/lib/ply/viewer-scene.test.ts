import { describe, expect, it } from "vitest";
import { resolvePLYViewerPackage } from "./viewer-scene";
import {
  buildPLY,
  convexQuadFaceElement,
  expectPLYError,
  pointCloudPLY,
  simpleTriangleFaceElement,
  simpleTriangleVertexElement,
  simpleTrianglePLY,
} from "./test-fixtures";
import { DEFAULT_PLY_VIEWER_LIMITS, type PLYViewerLimits } from "./viewer-types";
import type { PLYElementDesc } from "./test-fixtures";
import type { PLYFormat } from "./types";

const LIMITS = DEFAULT_PLY_VIEWER_LIMITS;
const FORMATS: PLYFormat[] = ["ascii", "binary_little_endian", "binary_big_endian"];

describe("resolvePLYViewerPackage — encoding", () => {
  it.each(FORMATS)("resolves a simple triangle in %s", (format) => {
    const result = resolvePLYViewerPackage(simpleTrianglePLY(format), LIMITS);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.format).toBe(format);
  });

  it("tolerates an unrelated custom element interspersed between vertex and face", () => {
    const custom: PLYElementDesc = { name: "material", count: 1, properties: [{ kind: "scalar", type: "float", name: "shininess" }], rows: [[0.5]] };
    const buffer = buildPLY({
      format: "ascii",
      elements: [simpleTriangleVertexElement(), custom, simpleTriangleFaceElement()],
    });
    const result = resolvePLYViewerPackage(buffer, LIMITS);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.sourceVertexCount).toBe(3);
    expect(result.unknownElementCount).toBe(1);
  });

  it("tolerates arbitrary property order within the vertex element (color before position)", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "uchar", name: "red" },
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
      ],
      rows: [[255, 1, 2, 3]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(Array.from(result.positions)).toEqual([1, 2, 3]);
    expect(result.colors![0]).toBeCloseTo(1, 4);
  });
});

describe("resolvePLYViewerPackage — geometry", () => {
  it("triangulates a convex quad", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 4,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
      ],
      rows: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, convexQuadFaceElement()] }), LIMITS);
    expect(result.renderedTriangleCount).toBe(2);
  });

  it("opens a point-cloud-only file successfully, unlike the converter", () => {
    const result = resolvePLYViewerPackage(pointCloudPLY(), LIMITS);
    expect(result.renderedTriangleCount).toBe(0);
    expect(result.renderedPointCount).toBe(3);
    expect(result.surfaceIndices).toBeUndefined();
    expect(result.normals).toBeUndefined();
  });

  it("throws PLY_VIEWER_NO_RENDERABLE_GEOMETRY for a file with zero vertices", () => {
    const vertex: PLYElementDesc = { name: "vertex", count: 0, properties: [{ kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" }], rows: [] };
    expectPLYError(() => resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS), "PLY_VIEWER_NO_RENDERABLE_GEOMETRY");
  });

  it("rejects an out-of-range face index the same way the converter does", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = { name: "face", count: 1, properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }], rows: [[[0, 1, 9]]] };
    expectPLYError(() => resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, face] }), LIMITS), "PLY_INDEX_OUT_OF_RANGE");
  });
});

describe("resolvePLYViewerPackage — edges", () => {
  it("renders a conventional vertex1/vertex2 edge element", () => {
    const vertex = simpleTriangleVertexElement();
    const edge: PLYElementDesc = {
      name: "edge",
      count: 2,
      properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }],
      rows: [[0, 1], [1, 2]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, edge] }), LIMITS);
    expect(result.edgeCount).toBe(2);
    expect(result.edgeIndices).toEqual(Uint32Array.from([0, 1, 1, 2]));
  });

  it("opens successfully with an edge-only file (no faces)", () => {
    const vertex = simpleTriangleVertexElement();
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }], rows: [[0, 2]] };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, edge] }), LIMITS);
    expect(result.edgeCount).toBe(1);
    expect(result.renderedTriangleCount).toBe(0);
    expect(result.renderedPointCount).toBe(3);
  });

  it("warns and skips an edge element with an unrecognized layout, without failing the file", () => {
    const vertex = simpleTriangleVertexElement();
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "v1" }, { kind: "scalar", type: "int", name: "v2" }], rows: [[0, 1]] };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, edge] }), LIMITS);
    expect(result.edgeIndices).toBeUndefined();
    expect(result.warnings.some((w) => w.code === "unrecognized-edge-layout")).toBe(true);
  });

  it("rejects an out-of-range edge vertex reference", () => {
    const vertex = simpleTriangleVertexElement();
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }], rows: [[0, 9]] };
    expectPLYError(() => resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, edge] }), LIMITS), "PLY_INDEX_OUT_OF_RANGE");
  });

  it("enforces the edge-count safety ceiling", () => {
    const limits: PLYViewerLimits = { ...LIMITS, maxEdgeCount: 1 };
    const vertex = simpleTriangleVertexElement();
    const edge: PLYElementDesc = { name: "edge", count: 2, properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }], rows: [[0, 1], [1, 2]] };
    expectPLYError(() => resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, edge] }), limits), "PLY_VIEWER_EDGE_LIMIT");
  });
});

describe("resolvePLYViewerPackage — mixed geometry and combined bounds", () => {
  it("includes surfaces, edges and points together in overall bounds (regression: the GLB combined-bounds bug class)", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 5,
      properties: [{ kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" }],
      rows: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [50, 50, 50], [-30, -30, -30]],
    };
    const face: PLYElementDesc = { name: "face", count: 1, properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }], rows: [[[0, 1, 2]]] };
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }], rows: [[0, 3]] };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, face, edge] }), LIMITS);
    // Vertex 4 (-30,-30,-30) is only ever a "point" (not in any face or edge) — it must still extend boundsModelUnits.
    expect(result.boundsModelUnits.min).toEqual([-30, -30, -30]);
    // Vertex 3 (50,50,50) is only referenced by the edge, not the face — boundsSurface must exclude it.
    expect(result.boundsSurface!.max).toEqual([1, 1, 0]);
    expect(result.boundsEdges!.max).toEqual([50, 50, 50]);
  });

  it("independently renders surfaces, edges and points from one file", () => {
    const vertex = simpleTriangleVertexElement();
    const face = simpleTriangleFaceElement();
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "vertex1" }, { kind: "scalar", type: "int", name: "vertex2" }], rows: [[0, 1]] };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, face, edge] }), LIMITS);
    expect(result.renderedTriangleCount).toBe(1);
    expect(result.edgeCount).toBe(1);
    expect(result.renderedPointCount).toBe(3);
  });
});

describe("resolvePLYViewerPackage — vertex attributes", () => {
  it("uses valid source normals", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "nx" }, { kind: "scalar", type: "float", name: "ny" }, { kind: "scalar", type: "float", name: "nz" },
      ],
      rows: [[0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1], [0, 1, 0, 0, 0, 1]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(result.hasSourceNormals).toBe(true);
    expect(result.normals![2]).toBeCloseTo(1, 4);
  });

  it("falls back to a computed geometric normal per-vertex when normals are missing", () => {
    const result = resolvePLYViewerPackage(simpleTrianglePLY(), LIMITS);
    expect(result.hasSourceNormals).toBe(false);
    const len = Math.hypot(result.normals![0], result.normals![1], result.normals![2]);
    expect(len).toBeCloseTo(1, 4);
  });

  it("falls back per-vertex for an invalid (zero-length) normal, warning but not failing", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "nx" }, { kind: "scalar", type: "float", name: "ny" }, { kind: "scalar", type: "float", name: "nz" },
      ],
      rows: [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 1], [0, 1, 0, 0, 0, 1]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(result.warnings.some((w) => w.code === "invalid-normal-fallback")).toBe(true);
    const len = Math.hypot(result.normals![0], result.normals![1], result.normals![2]);
    expect(len).toBeCloseTo(1, 4);
  });

  it("normalizes uchar (uint8) RGB colors by /255", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "uchar", name: "red" }, { kind: "scalar", type: "uchar", name: "green" }, { kind: "scalar", type: "uchar", name: "blue" },
      ],
      rows: [[0, 0, 0, 255, 0, 0], [1, 0, 0, 255, 0, 0], [0, 1, 0, 255, 0, 0]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.hasVertexColors).toBe(true);
    expect(result.colors![0]).toBeCloseTo(1, 5);
    expect(result.colors![1]).toBeCloseTo(0, 5);
  });

  it("normalizes ushort (uint16) colors by /65535", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "ushort", name: "red" }, { kind: "scalar", type: "ushort", name: "green" }, { kind: "scalar", type: "ushort", name: "blue" },
      ],
      rows: [[0, 0, 0, 65535, 0, 32767]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.colors![0]).toBeCloseTo(1, 4);
    expect(result.colors![2]).toBeCloseTo(0.5, 3);
  });

  it("accepts floating-point colors already in 0..1", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "red" }, { kind: "scalar", type: "float", name: "green" }, { kind: "scalar", type: "float", name: "blue" },
      ],
      rows: [[0, 0, 0, 0.25, 0.5, 0.75]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.colors![0]).toBeCloseTo(0.25, 4);
  });

  it("clamps an out-of-range color value and warns", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "red" }, { kind: "scalar", type: "float", name: "green" }, { kind: "scalar", type: "float", name: "blue" },
      ],
      rows: [[0, 0, 0, 2.5, -1, 0.5]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.colors![0]).toBe(1);
    expect(result.colors![1]).toBe(0);
    expect(result.warnings.some((w) => w.code === "invalid-color-clamped")).toBe(true);
  });

  it("resolves a u/v texture-coordinate pair", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "u" }, { kind: "scalar", type: "float", name: "v" },
      ],
      rows: [[0, 0, 0, 0.5, 0.75]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.hasTextureCoordinates).toBe(true);
    expect(result.uvs![0]).toBeCloseTo(0.5, 4);
  });

  it("does not report texture coordinates for an incomplete (single) UV property", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "u" },
      ],
      rows: [[0, 0, 0, 0.5]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.hasTextureCoordinates).toBe(false);
  });

  it("reports alpha availability separately from RGB", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "uchar", name: "red" }, { kind: "scalar", type: "uchar", name: "green" }, { kind: "scalar", type: "uchar", name: "blue" }, { kind: "scalar", type: "uchar", name: "alpha" },
      ],
      rows: [[0, 0, 0, 255, 255, 255, 128]],
    };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex] }), LIMITS);
    expect(result.hasAlpha).toBe(true);
    expect(result.colors![3]).toBeCloseTo(128 / 255, 3);
  });
});

describe("resolvePLYViewerPackage — metadata", () => {
  it("counts comments and obj_info entries", () => {
    const buffer = buildPLY({ format: "ascii", elements: [simpleTriangleVertexElement()], comments: ["a", "b"] });
    const result = resolvePLYViewerPackage(buffer, LIMITS);
    expect(result.commentCount).toBe(2);
  });

  it("counts unknown elements and properties without interpreting them", () => {
    const vertex = simpleTriangleVertexElement();
    const custom: PLYElementDesc = { name: "material", count: 1, properties: [{ kind: "scalar", type: "float", name: "shininess" }], rows: [[0.5]] };
    const result = resolvePLYViewerPackage(buildPLY({ format: "ascii", elements: [vertex, custom] }), LIMITS);
    expect(result.unknownElementCount).toBe(1);
  });
});
