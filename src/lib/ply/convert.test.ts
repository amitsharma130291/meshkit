import { describe, expect, it } from "vitest";
import { convertPLYBuffer } from "./convert";
import { DEFAULT_PLY_LIMITS } from "./types";
import { buildPLY, convexQuadPLY, expectPLYError, pointCloudPLY, simpleTriangleVertexElement, simpleTrianglePLY, type PLYElementDesc } from "./test-fixtures";

const LIMITS = DEFAULT_PLY_LIMITS;

describe("convertPLYBuffer", () => {
  it("converts a simple triangle to STL-ready geometry with no warnings", () => {
    const result = convertPLYBuffer(simpleTrianglePLY("ascii"), LIMITS);
    expect(result.triangleCount).toBe(1);
    expect(result.positions).toHaveLength(9);
    expect(result.normals).toHaveLength(9);
    expect(result.warnings).toEqual([]);
    expect(result.bounds.min).toEqual([0, 0, 0]);
  });

  it("triangulates a convex quad into two triangles in the final result", () => {
    const result = convertPLYBuffer(convexQuadPLY("ascii"), LIMITS);
    expect(result.triangleCount).toBe(2);
  });

  it("warns about vertex colors", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "uchar", name: "red" },
        { kind: "scalar", type: "uchar", name: "green" },
        { kind: "scalar", type: "uchar", name: "blue" },
      ],
      rows: [
        [0, 0, 0, 255, 0, 0],
        [1, 0, 0, 0, 255, 0],
        [0, 1, 0, 0, 0, 255],
      ],
    };
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [[[0, 1, 2]]],
    };
    const result = convertPLYBuffer(buildPLY({ format: "ascii", elements: [vertex, face] }), LIMITS);
    expect(result.warnings.map((w) => w.code)).toContain("vertex-colors-not-preserved");
  });

  it("warns about an unknown element and unknown properties, each once (aggregated, not per-item)", () => {
    const edge: PLYElementDesc = { name: "edge", count: 1, properties: [{ kind: "scalar", type: "int", name: "a" }], rows: [[0]] };
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "confidence" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "intensity" },
        { kind: "scalar", type: "float", name: "z" },
      ],
      rows: [[0, 0.9, 0, 128, 0]],
    };
    const face: PLYElementDesc = {
      name: "face",
      count: 0,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [],
    };
    // Give it three vertices and a real face so geometry actually builds.
    const threeVertex: PLYElementDesc = { ...vertex, count: 3, rows: [...vertex.rows, [1, 0.1, 0, 1, 0], [0, 0.1, 1, 1, 0]] };
    const realFace: PLYElementDesc = { ...face, count: 1, rows: [[[0, 1, 2]]] };
    const result = convertPLYBuffer(buildPLY({ format: "ascii", elements: [edge, threeVertex, realFace] }), LIMITS);
    expect(result.warnings.filter((w) => w.code === "unknown-elements-skipped")).toHaveLength(1);
    expect(result.warnings.filter((w) => w.code === "unknown-properties-skipped")).toHaveLength(1);
  });

  it("warns when the source used double-precision coordinates", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "double", name: "x" },
        { kind: "scalar", type: "double", name: "y" },
        { kind: "scalar", type: "double", name: "z" },
      ],
      rows: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    };
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [[[0, 1, 2]]],
    };
    const result = convertPLYBuffer(buildPLY({ format: "ascii", elements: [vertex, face] }), LIMITS);
    expect(result.warnings.map((w) => w.code)).toContain("double-precision-narrowed");
  });

  it("rejects a point-cloud-only file", () => {
    expectPLYError(() => convertPLYBuffer(pointCloudPLY("ascii"), LIMITS), "PLY_FACE_ELEMENT_MISSING");
  });

  it("rejects a file with a face element declared but zero rows, as no-face-geometry", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 0,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => convertPLYBuffer(buffer, LIMITS), "PLY_NO_FACE_GEOMETRY");
  });

  it("rejects a completely empty file as empty geometry", () => {
    const vertex: PLYElementDesc = { name: "vertex", count: 0, properties: [{ kind: "scalar", type: "float", name: "x" }, { kind: "scalar", type: "float", name: "y" }, { kind: "scalar", type: "float", name: "z" }], rows: [] };
    const face: PLYElementDesc = { name: "face", count: 0, properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }], rows: [] };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => convertPLYBuffer(buffer, LIMITS), "PLY_EMPTY_GEOMETRY");
  });
});
