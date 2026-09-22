import { describe, expect, it } from "vitest";
import { parsePLYDocument } from "./parser";
import { DEFAULT_PLY_LIMITS } from "./types";
import {
  buildPLY,
  convexQuadPLY,
  expectPLYError,
  pointCloudPLY,
  simpleTriangleFaceElement,
  simpleTriangleVertexElement,
  simpleTrianglePLY,
  textToBuffer,
  type PLYElementDesc,
} from "./test-fixtures";

const LIMITS = DEFAULT_PLY_LIMITS;

describe("parsePLYDocument — ASCII", () => {
  it("parses a simple triangle", () => {
    const doc = parsePLYDocument(simpleTrianglePLY("ascii"), LIMITS);
    expect(doc.sourceVertexCount).toBe(3);
    expect(doc.sourceFaceCount).toBe(1);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
    expect(doc.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(doc.format).toBe("ascii");
  });

  it("triangulates a convex quad face into two triangles", () => {
    const doc = parsePLYDocument(convexQuadPLY("ascii"), LIMITS);
    expect(doc.triangles).toHaveLength(2);
  });
});

describe("parsePLYDocument — binary", () => {
  it("parses a simple triangle in binary_little_endian", () => {
    const doc = parsePLYDocument(simpleTrianglePLY("binary_little_endian"), LIMITS);
    expect(doc.sourceVertexCount).toBe(3);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
    expect(doc.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("parses a simple triangle in binary_big_endian", () => {
    const doc = parsePLYDocument(simpleTrianglePLY("binary_big_endian"), LIMITS);
    expect(doc.sourceVertexCount).toBe(3);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
    expect(doc.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("produces identical geometry across ascii, LE and BE encodings of the same file", () => {
    const ascii = parsePLYDocument(convexQuadPLY("ascii"), LIMITS);
    const le = parsePLYDocument(convexQuadPLY("binary_little_endian"), LIMITS);
    const be = parsePLYDocument(convexQuadPLY("binary_big_endian"), LIMITS);
    expect(le.positions).toEqual(ascii.positions);
    expect(be.positions).toEqual(ascii.positions);
    expect(le.triangles).toEqual(ascii.triangles);
    expect(be.triangles).toEqual(ascii.triangles);
  });
});

describe("parsePLYDocument — arbitrary property order", () => {
  it("reads x/y/z correctly regardless of their position among other vertex properties", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "uchar", name: "red" },
        { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "uchar", name: "green" },
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "uchar", name: "blue" },
        { kind: "scalar", type: "float", name: "y" },
      ],
      rows: [
        [255, 3, 128, 1, 64, 2],
        [255, 0, 128, 0, 64, 0],
        [255, 0, 128, 0, 64, 1],
      ],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.positions.slice(0, 3)).toEqual([1, 2, 3]);
    expect(doc.hasVertexColors).toBe(true);
  });

  it("reads a face's vertex_indices property regardless of its position among other face properties", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [
        { kind: "scalar", type: "int", name: "material_index" },
        { kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" },
      ],
      rows: [[7, [0, 1, 2]]],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, face] }), LIMITS);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
    expect(doc.unknownPropertyCount).toBe(1);
  });
});

describe("parsePLYDocument — vertex/face extraction rules", () => {
  it("rejects a file with no vertex element", () => {
    const buffer = buildPLY({ format: "ascii", elements: [simpleTriangleFaceElement()] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_VERTEX_ELEMENT_MISSING");
  });

  it("rejects a vertex element missing a coordinate", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
      ],
      rows: [[0, 0]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_VERTEX_COORDINATE_MISSING");
  });

  it("rejects a vertex coordinate declared as a list", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 1,
      properties: [
        { kind: "list", countType: "uchar", itemType: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
      ],
      rows: [[[1], 0, 0]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_VERTEX_COORDINATE_TYPE_INVALID");
  });

  it("rejects a point-cloud-only file (no face element) rather than synthesizing a surface", () => {
    expectPLYError(() => parsePLYDocument(pointCloudPLY("ascii"), LIMITS), "PLY_FACE_ELEMENT_MISSING");
  });

  it("rejects a face element with no vertex_indices/vertex_index list property", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "scalar", type: "int", name: "material_index" }],
      rows: [[7]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_FACE_INDEX_PROPERTY_MISSING");
  });

  it("accepts the vertex_index alias as well as vertex_indices", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_index" }],
      rows: [[[0, 1, 2]]],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, face] }), LIMITS);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
  });

  it("rejects a face element with both vertex_indices and vertex_index as ambiguous", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [
        { kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" },
        { kind: "list", countType: "uchar", itemType: "int", name: "vertex_index" },
      ],
      rows: [[[0, 1, 2], [0, 1, 2]]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_FACE_INDEX_PROPERTY_AMBIGUOUS");
  });

  it("rejects a vertex_indices list declared with a non-integer item type", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "float", name: "vertex_indices" }],
      rows: [[[0, 1, 2]]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_FACE_INDEX_TYPE_INVALID");
  });

  it("rejects a face index referencing a vertex that doesn't exist", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [[[0, 1, 99]]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_INDEX_OUT_OF_RANGE");
  });
});

describe("parsePLYDocument — unknown elements/properties", () => {
  it("skips an unknown element while keeping later elements aligned", () => {
    const edge: PLYElementDesc = {
      name: "edge",
      count: 2,
      properties: [
        { kind: "scalar", type: "int", name: "vertex1" },
        { kind: "scalar", type: "int", name: "vertex2" },
      ],
      rows: [
        [0, 1],
        [1, 2],
      ],
    };
    const buffer = buildPLY({ format: "ascii", elements: [edge, simpleTriangleVertexElement(), simpleTriangleFaceElement()] });
    const doc = parsePLYDocument(buffer, LIMITS);
    expect(doc.unknownElementCount).toBe(1);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
  });

  it("counts unrecognized vertex/face properties as unknown and skips them without misaligning later reads", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "confidence" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "intensity" },
        { kind: "scalar", type: "float", name: "z" },
      ],
      rows: [
        [1, 0.9, 2, 128, 3],
        [0, 0.1, 0, 1, 0],
        [0, 0.1, 1, 1, 0],
      ],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.positions.slice(0, 3)).toEqual([1, 2, 3]);
    expect(doc.unknownPropertyCount).toBe(2);
  });
});

describe("parsePLYDocument — vertex color/normal/texcoord classification", () => {
  it("flags vertex colors without counting them as unknown", () => {
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
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.hasVertexColors).toBe(true);
    expect(doc.unknownPropertyCount).toBe(0);
  });

  it("flags vertex normals without counting them as unknown", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "nx" },
        { kind: "scalar", type: "float", name: "ny" },
        { kind: "scalar", type: "float", name: "nz" },
      ],
      rows: [
        [0, 0, 0, 0, 1, 0],
        [1, 0, 0, 0, 1, 0],
        [0, 1, 0, 0, 1, 0],
      ],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.hasVertexNormals).toBe(true);
    expect(doc.unknownPropertyCount).toBe(0);
  });

  it("flags texture coordinates without counting them as unknown", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "float", name: "x" },
        { kind: "scalar", type: "float", name: "y" },
        { kind: "scalar", type: "float", name: "z" },
        { kind: "scalar", type: "float", name: "s" },
        { kind: "scalar", type: "float", name: "t" },
      ],
      rows: [
        [0, 0, 0, 0.5, 0.5],
        [1, 0, 0, 1, 0],
        [0, 1, 0, 0, 1],
      ],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.hasTextureCoordinates).toBe(true);
    expect(doc.unknownPropertyCount).toBe(0);
  });
});

describe("parsePLYDocument — Float64 narrowing", () => {
  it("flags a double-precision source coordinate for narrowing, but not a double-precision non-coordinate property", () => {
    const vertex: PLYElementDesc = {
      name: "vertex",
      count: 3,
      properties: [
        { kind: "scalar", type: "double", name: "x" },
        { kind: "scalar", type: "double", name: "y" },
        { kind: "scalar", type: "double", name: "z" },
      ],
      rows: [
        [1, 2, 3],
        [0, 0, 0],
        [1, 1, 0],
      ],
    };
    const doc = parsePLYDocument(buildPLY({ format: "ascii", elements: [vertex, simpleTriangleFaceElement()] }), LIMITS);
    expect(doc.hasDoublePrecisionSource).toBe(true);
  });

  it("does not flag narrowing when coordinates are float32", () => {
    const doc = parsePLYDocument(simpleTrianglePLY("ascii"), LIMITS);
    expect(doc.hasDoublePrecisionSource).toBe(false);
  });
});

describe("parsePLYDocument — malformed body", () => {
  const FACE_HEADER_LINES = [
    "element face 1",
    "property list uchar int vertex_indices",
  ];

  it("rejects a non-numeric ASCII value", () => {
    const buffer = textToBuffer(
      [
        "ply",
        "format ascii 1.0",
        "element vertex 1",
        "property float x",
        "property float y",
        "property float z",
        ...FACE_HEADER_LINES,
        "end_header",
        "0 0 not-a-number",
      ].join("\n") + "\n",
    );
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_ASCII_VALUE_INVALID");
  });

  it("rejects a truncated ASCII body", () => {
    const buffer = textToBuffer(
      [
        "ply",
        "format ascii 1.0",
        "element vertex 2",
        "property float x",
        "property float y",
        "property float z",
        ...FACE_HEADER_LINES,
        "end_header",
        "0 0 0",
      ].join("\n") + "\n",
    );
    expectPLYError(() => parsePLYDocument(buffer, LIMITS), "PLY_BODY_TRUNCATED");
  });

  it("rejects a truncated binary body", () => {
    const full = simpleTrianglePLY("binary_little_endian");
    const truncated = full.slice(0, full.byteLength - 4);
    expectPLYError(() => parsePLYDocument(truncated, LIMITS), "PLY_BODY_TRUNCATED");
  });

  it("rejects a list length that exceeds the configured safety ceiling", () => {
    const vertex = simpleTriangleVertexElement();
    const face: PLYElementDesc = {
      name: "face",
      count: 1,
      properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
      rows: [[[0, 1, 2]]],
    };
    const buffer = buildPLY({ format: "ascii", elements: [vertex, face] });
    expectPLYError(() => parsePLYDocument(buffer, { ...LIMITS, maxListCount: 2 }), "PLY_LIST_LENGTH_INVALID");
  });
});

describe("parsePLYDocument — limits", () => {
  it("rejects a file larger than maxFileBytes", () => {
    const buffer = simpleTrianglePLY("ascii");
    expectPLYError(() => parsePLYDocument(buffer, { ...LIMITS, maxFileBytes: 4 }), "PLY_FILE_TOO_LARGE");
  });

  it("rejects more vertices than maxVertexCount", () => {
    const buffer = simpleTrianglePLY("ascii");
    expectPLYError(() => parsePLYDocument(buffer, { ...LIMITS, maxVertexCount: 2 }), "PLY_VERTEX_LIMIT_EXCEEDED");
  });

  it("rejects a face with more vertices than maxFaceVertexCount", () => {
    const buffer = convexQuadPLY("ascii");
    expectPLYError(() => parsePLYDocument(buffer, { ...LIMITS, maxFaceVertexCount: 3 }), "PLY_FACE_VERTEX_LIMIT_EXCEEDED");
  });
});
