import { describe, expect, it } from "vitest";
import { convertOBJText } from "./convert";
import {
  bowtieQuadOBJ,
  buildOBJText,
  concaveLShapeOBJ,
  concaveQuadOBJ,
  convexQuadOBJ,
  expectOBJError,
  simpleTriangleOBJ,
} from "./test-fixtures";
import { parseBinarySTL } from "../stl/parse-binary";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { computeBounds } from "../stl/bounds";
import { DEFAULT_STL_LIMITS } from "../stl/types";

describe("convertOBJText — geometry", () => {
  it("converts a single triangle", () => {
    const result = convertOBJText(simpleTriangleOBJ());
    expect(result.triangleCount).toBe(1);
    expect(result.positions).toHaveLength(9);
    expect(result.sourceVertexCount).toBe(3);
    expect(result.sourceFaceCount).toBe(1);
  });

  it("converts multiple triangles from a triangulated quad", () => {
    const result = convertOBJText(convexQuadOBJ());
    expect(result.triangleCount).toBe(2);
  });

  it("converts a concave polygon without corrupted output", () => {
    const result = convertOBJText(concaveQuadOBJ());
    expect(result.triangleCount).toBe(2);
    for (const value of result.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it("converts a concave L-shape into the correct number of triangles", () => {
    const result = convertOBJText(concaveLShapeOBJ());
    expect(result.triangleCount).toBe(4);
  });

  it("rejects a self-intersecting face safely instead of emitting corrupted geometry", () => {
    expectOBJError(() => convertOBJText(bowtieQuadOBJ()), "OBJ_POLYGON_SELF_INTERSECTING");
  });

  it("recalculates geometric face normals rather than trusting declared vn values", () => {
    // Declared normal points the "wrong" way (into the page); MeshKit must
    // still emit the geometrically-correct outward normal for this winding.
    const text = buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 -1", "f 1//1 2//1 3//1"]);
    const result = convertOBJText(text);
    expect(Array.from(result.normals.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it("preserves numeric coordinates exactly, with no unit scaling", () => {
    const text = buildOBJText(["v 0 0 0", "v 25.4 0 0", "v 0 25.4 0", "f 1 2 3"]);
    const result = convertOBJText(text);
    expect(result.positions[3]).toBeCloseTo(25.4, 5);
  });
});

describe("convertOBJText — metadata and warnings", () => {
  it("reports object, group and material counts", () => {
    const text = buildOBJText([
      "mtllib scene.mtl",
      "usemtl red",
      "o first",
      "g a",
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
      "o second",
      "g b",
    ]);
    const result = convertOBJText(text);
    expect(result.objectCount).toBe(2);
    expect(result.groupCount).toBe(2);
    expect(result.materialLibraryCount).toBe(1);
    expect(result.usedMaterialCount).toBe(1);
  });

  it("warns that materials aren't preserved", () => {
    const text = buildOBJText(["mtllib scene.mtl", "usemtl red", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]);
    const result = convertOBJText(text);
    expect(result.warnings.some((w) => w.code === "materials-not-preserved")).toBe(true);
  });

  it("warns that smooth shading is converted", () => {
    const text = buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 1", "s 1", "f 1//1 2//1 3//1"]);
    const result = convertOBJText(text);
    expect(result.warnings.some((w) => w.code === "smooth-shading-converted")).toBe(true);
  });

  it("warns that multiple objects/groups are merged", () => {
    const text = buildOBJText([
      "o a",
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
      "o b",
      "v 2 2 2",
      "v 3 2 2",
      "v 2 3 2",
      "f 4 5 6",
    ]);
    const result = convertOBJText(text);
    expect(result.warnings.some((w) => w.code === "groups-merged")).toBe(true);
  });

  it("warns that vertex colors aren't preserved", () => {
    const text = buildOBJText(["v 0 0 0 1 0 0", "v 1 0 0 0 1 0", "v 0 1 0 0 0 1", "f 1 2 3"]);
    const result = convertOBJText(text);
    expect(result.warnings.some((w) => w.code === "vertex-colors-not-preserved")).toBe(true);
  });

  it("warns about ignored line and point primitives when triangle geometry is also present", () => {
    const text = buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", "l 1 2", "p 1"]);
    const result = convertOBJText(text);
    expect(result.warnings.some((w) => w.code === "lines-ignored")).toBe(true);
    expect(result.warnings.some((w) => w.code === "points-ignored")).toBe(true);
  });
});

describe("convertOBJText — unsupported/empty geometry", () => {
  it("rejects a file containing only line primitives", () => {
    expectOBJError(() => convertOBJText(buildOBJText(["v 0 0 0", "v 1 0 0", "l 1 2"])), "OBJ_UNSUPPORTED_GEOMETRY");
  });

  it("rejects a file containing only point primitives", () => {
    expectOBJError(() => convertOBJText(buildOBJText(["v 0 0 0", "p 1"])), "OBJ_UNSUPPORTED_GEOMETRY");
  });

  it("rejects a completely empty file", () => {
    expectOBJError(() => convertOBJText(""), "OBJ_EMPTY_GEOMETRY");
  });

  it("rejects a file with vertices but no faces at all", () => {
    expectOBJError(() => convertOBJText(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0"])), "OBJ_NO_FACE_GEOMETRY");
  });
});

describe("convertOBJText — binary STL round trip", () => {
  it("round-trips through the shared binary STL serializer and parser with equivalent triangle count and bounds", () => {
    const result = convertOBJText(concaveLShapeOBJ());
    const stlBuffer = serializeBinarySTL({ positions: result.positions, normals: result.normals });
    const parsed = parseBinarySTL(stlBuffer, DEFAULT_STL_LIMITS);

    expect(parsed.triangleCount).toBe(result.triangleCount);
    expect(computeBounds(parsed.positions)).toEqual(result.bounds);
  });
});
