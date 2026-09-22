import { describe, expect, it } from "vitest";
import { parseOBJDocument } from "./parser";
import { buildOBJText, expectOBJError } from "./test-fixtures";
import { DEFAULT_OBJ_LIMITS, type OBJLimits } from "./types";

const LIMITS: OBJLimits = DEFAULT_OBJ_LIMITS;

describe("parseOBJDocument — vertices", () => {
  it("parses a plain x y z vertex", () => {
    const doc = parseOBJDocument(buildOBJText(["v 1 2 3"]), LIMITS);
    expect(doc.positions.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("supports scientific notation", () => {
    const doc = parseOBJDocument(buildOBJText(["v 1e2 -2.5e-1 3E0"]), LIMITS);
    expect(doc.positions).toEqual([100, -0.25, 3]);
  });

  it("rejects a non-finite coordinate", () => {
    expectOBJError(() => parseOBJDocument(buildOBJText(["v NaN 0 0"]), LIMITS), "OBJ_VERTEX_INVALID");
    expectOBJError(() => parseOBJDocument(buildOBJText(["v Infinity 0 0"]), LIMITS), "OBJ_VERTEX_INVALID");
  });

  it("rejects an invalid numeric token", () => {
    expectOBJError(() => parseOBJDocument(buildOBJText(["v x 0 0"]), LIMITS), "OBJ_VERTEX_INVALID");
  });

  it("enforces the coordinate magnitude limit", () => {
    const limits: OBJLimits = { ...LIMITS, maxCoordinateMagnitude: 100 };
    expectOBJError(() => parseOBJDocument(buildOBJText(["v 1000 0 0"]), limits), "OBJ_VERTEX_INVALID");
  });

  it("enforces the vertex-count limit before large allocations", () => {
    const limits: OBJLimits = { ...LIMITS, maxVertexCount: 1 };
    expectOBJError(() => parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 1 1"]), limits), "OBJ_VERTEX_LIMIT_EXCEEDED");
  });

  it("divides by w for 4-field homogeneous coordinates", () => {
    const doc = parseOBJDocument(buildOBJText(["v 2 4 6 2"]), LIMITS);
    expect(doc.positions).toEqual([1, 2, 3]);
  });

  it("rejects a zero w", () => {
    expectOBJError(() => parseOBJDocument(buildOBJText(["v 1 2 3 0"]), LIMITS), "OBJ_VERTEX_INVALID");
  });

  it("treats a 6-field vertex as the color extension and warns rather than misreading it as homogeneous", () => {
    const doc = parseOBJDocument(buildOBJText(["v 1 2 3 0.5 0.5 0.5"]), LIMITS);
    expect(doc.positions.slice(0, 3)).toEqual([1, 2, 3]);
    expect(doc.hasVertexColorData).toBe(true);
  });

  it("rejects an ambiguous 7-field vertex line rather than guessing", () => {
    expectOBJError(() => parseOBJDocument(buildOBJText(["v 1 2 3 1 0.5 0.5 0.5"]), LIMITS), "OBJ_VERTEX_INVALID");
  });
});

describe("parseOBJDocument — text structure", () => {
  it("ignores blank lines and comments", () => {
    const doc = parseOBJDocument(buildOBJText(["", "# a comment", "v 0 0 0", "  "]), LIMITS);
    expect(doc.sourceVertexCount).toBe(1);
  });

  it("ignores an unknown statement keyword without treating it as geometry", () => {
    const doc = parseOBJDocument(buildOBJText(["vp 0.5 0.5", "v 0 0 0"]), LIMITS);
    expect(doc.sourceVertexCount).toBe(1);
  });
});

describe("parseOBJDocument — face references", () => {
  it("parses all four face-reference forms, including mixed within one file", () => {
    const doc = parseOBJDocument(
      buildOBJText([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "vt 0 0",
        "vt 1 0",
        "vt 0 1",
        "vn 0 0 1",
        "f 1 2 3",
        "f 1/1 2/2 3/3",
        "f 1//1 2//1 3//1",
        "f 1/1/1 2/2/1 3/3/1",
      ]),
      LIMITS,
    );
    expect(doc.sourceFaceCount).toBe(4);
    expect(doc.triangles).toHaveLength(4);
  });

  it("resolves negative face indices against the counts available at that point in the file, not the file's final totals", () => {
    // Only two vertices exist when the face is parsed. -3 relative to that
    // count is out of range and must be rejected — a buggy implementation
    // that resolved against the file's FINAL vertex count (5) would
    // wrongly accept it instead.
    expectOBJError(
      () =>
        parseOBJDocument(
          buildOBJText(["v 0 0 0", "v 1 0 0", "f -3 -1 -2", "v 2 2 2", "v 3 3 3", "v 4 4 4"]),
          LIMITS,
        ),
      "OBJ_INDEX_OUT_OF_RANGE",
    );
  });

  it("resolves a genuine negative-index triangle correctly", () => {
    const doc = parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f -3 -2 -1"]), LIMITS);
    expect(doc.positions.slice(0, 9)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
  });

  it("rejects a face with fewer than three vertices", () => {
    expectOBJError(() => parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "f 1 2"]), LIMITS), "OBJ_FACE_TOO_SMALL");
  });

  it("normalizes a repeated closing vertex", () => {
    const doc = parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3 1"]), LIMITS);
    expect(doc.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
  });

  it("rejects a non-closing repeated vertex reference", () => {
    expectOBJError(
      () => parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 1 3"]), LIMITS),
      "OBJ_FACE_INVALID",
    );
  });

  it("enforces the per-face vertex limit", () => {
    const limits: OBJLimits = { ...LIMITS, maxFaceVertexCount: 3 };
    expectOBJError(
      () => parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1 2 3 4"]), limits),
      "OBJ_FACE_VERTEX_LIMIT_EXCEEDED",
    );
  });
});

describe("parseOBJDocument — objects, groups, materials, smoothing", () => {
  it("counts multiple object declarations", () => {
    const doc = parseOBJDocument(
      buildOBJText(["o first", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", "o second", "v 2 2 2"]),
      LIMITS,
    );
    expect(doc.objectCount).toBe(2);
  });

  it("counts unique group declarations", () => {
    const doc = parseOBJDocument(buildOBJText(["g a", "g b c", "g a"]), LIMITS);
    expect(doc.groupCount).toBe(3);
  });

  it("tracks smoothing-group usage, ignoring 'off'", () => {
    const withSmoothing = parseOBJDocument(buildOBJText(["s 1"]), LIMITS);
    expect(withSmoothing.usesSmoothShading).toBe(true);
    const withoutSmoothing = parseOBJDocument(buildOBJText(["s off"]), LIMITS);
    expect(withoutSmoothing.usesSmoothShading).toBe(false);
  });

  it("counts material-library declarations and distinct used materials", () => {
    const doc = parseOBJDocument(buildOBJText(["mtllib a.mtl", "usemtl red", "usemtl blue", "usemtl red"]), LIMITS);
    expect(doc.materialLibraryCount).toBe(1);
    expect(doc.usedMaterialCount).toBe(2);
  });

  it("tracks declared texture coordinates and vertex normals", () => {
    const doc = parseOBJDocument(buildOBJText(["vt 0.5 0.5", "vn 0 0 1"]), LIMITS);
    expect(doc.hasTextureCoordinates).toBe(true);
    expect(doc.hasVertexNormals).toBe(true);
  });
});

describe("parseOBJDocument — lines and points", () => {
  it("counts line and point statements without turning them into geometry", () => {
    const doc = parseOBJDocument(buildOBJText(["v 0 0 0", "v 1 0 0", "l 1 2", "p 1"]), LIMITS);
    expect(doc.ignoredLineCount).toBe(1);
    expect(doc.ignoredPointCount).toBe(1);
    expect(doc.triangles).toHaveLength(0);
  });
});
