import { describe, expect, it } from "vitest";
import { buildOBJViewerGeometry, parseOBJForViewer, parseOBJViewerDocument } from "./viewer-geometry";
import { buildOBJText, concaveQuadOBJ, expectOBJError } from "./test-fixtures";
import { DEFAULT_OBJ_VIEWER_LIMITS, type OBJViewerLimits } from "./viewer-types";

const LIMITS = DEFAULT_OBJ_VIEWER_LIMITS;

describe("parseOBJForViewer — basic geometry", () => {
  it("parses a triangle into one triangle with one segment", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), LIMITS);
    expect(result.triangleCount).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ objectName: "Default", groupNames: ["Default"], triangleStart: 0, triangleCount: 1 });
  });

  it("triangulates a convex quad into two triangles", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 2 0 0", "v 2 2 0", "v 0 2 0", "f 1 2 3 4"]), LIMITS);
    expect(result.triangleCount).toBe(2);
    expect(result.sourceFaceCount).toBe(1);
  });

  it("triangulates a concave polygon safely", () => {
    const result = parseOBJForViewer(concaveQuadOBJ(), LIMITS);
    expect(result.triangleCount).toBeGreaterThanOrEqual(2);
  });

  it("resolves negative face indices the same way the converter does", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f -3 -2 -1"]), LIMITS);
    expect(result.triangleCount).toBe(1);
    expect(Array.from(result.positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("rejects an out-of-range face index, matching the converter's error", () => {
    expectOBJError(() => parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "f 1 2 5"]), LIMITS), "OBJ_INDEX_OUT_OF_RANGE");
  });
});

describe("parseOBJForViewer — objects, groups and segments", () => {
  it("labels faces before any o/g statement as Default/Default", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), LIMITS);
    expect(result.segments[0].objectName).toBe("Default");
    expect(result.segments[0].groupNames).toEqual(["Default"]);
  });

  it("starts a new segment when the object changes", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "o first",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        "o second",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].objectName).toBe("first");
    expect(result.segments[1].objectName).toBe("second");
    expect(result.objectCount).toBe(2);
  });

  it("starts a new segment when the group changes", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "g a",
        "f 1 2 3",
        "g b",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].groupNames).toEqual(["a"]);
    expect(result.segments[1].groupNames).toEqual(["b"]);
    expect(result.groupCount).toBe(2);
  });

  it("starts a new segment when the active material changes", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "usemtl red",
        "f 1 2 3",
        "usemtl blue",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].materialName).toBe("red");
    expect(result.segments[1].materialName).toBe("blue");
    expect(result.usedMaterialCount).toBe(2);
    expect(result.usedMaterialNames.sort()).toEqual(["blue", "red"]);
  });

  it("starts a new segment when the smoothing group changes", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "s 1",
        "f 1 2 3",
        "s 2",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].smoothingGroup).toBe(1);
    expect(result.segments[1].smoothingGroup).toBe(2);
  });

  it("does not start a new segment when state is unchanged (avoids empty duplicate segments)", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "g a",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "f 1 2 3",
        "g a",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].triangleCount).toBe(2);
  });

  it("supports multiple simultaneous group names from one g statement", () => {
    const result = parseOBJForViewer(buildOBJText(["g a b c", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), LIMITS);
    expect(result.segments[0].groupNames).toEqual(["a", "b", "c"]);
    expect(result.groupCount).toBe(3);
  });

  it("truncates a name longer than the configured maxNameLength", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxNameLength: 8 };
    const result = parseOBJForViewer(buildOBJText(["o abcdefghijklmnop", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), limits);
    expect(result.segments[0].objectName.length).toBe(8);
    expect(result.segments[0].objectName.endsWith("…")).toBe(true);
  });

  it("limits simultaneous group names per statement to maxGroupNamesPerStatement", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxGroupNamesPerStatement: 2 };
    const result = parseOBJForViewer(buildOBJText(["g a b c d", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), limits);
    expect(result.segments[0].groupNames).toEqual(["a", "b"]);
  });

  it("preserves deterministic, source-order segment ordering", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "g z",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        "g a",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments.map((s) => s.groupNames[0])).toEqual(["z", "a"]);
  });

  it("throws OBJ_VIEWER_SEGMENT_LIMIT once the segment ceiling is exceeded", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxSegments: 1 };
    const lines = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "v 2 2 2", "v 3 2 2", "v 2 3 2", "g a", "f 1 2 3", "g b", "f 4 5 6"];
    expectOBJError(() => parseOBJForViewer(buildOBJText(lines), limits), "OBJ_VIEWER_SEGMENT_LIMIT");
  });
});

describe("parseOBJForViewer — normals", () => {
  it("uses a valid positive-index vn for a face corner", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 1", "f 1//1 2//1 3//1"]),
      LIMITS,
    );
    expect(result.hasValidSourceNormals).toBe(true);
    expect(Array.from(result.normals.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it("resolves a negative vn index", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 1", "f 1//-1 2//-1 3//-1"]),
      LIMITS,
    );
    expect(result.hasValidSourceNormals).toBe(true);
  });

  it("normalizes a non-unit-length valid normal", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 5", "f 1//1 2//1 3//1"]),
      LIMITS,
    );
    const length = Math.hypot(result.normals[0], result.normals[1], result.normals[2]);
    expect(length).toBeCloseTo(1, 5);
  });

  it("falls back to the geometric normal, and hasValidSourceNormals stays false, when no face references a vn", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), LIMITS);
    expect(result.hasValidSourceNormals).toBe(false);
    expect(Array.from(result.normals.slice(0, 3))).toEqual(Array.from(result.flatNormals.slice(0, 3)));
  });

  it("falls back per corner and warns for a zero-length vn, without discarding the whole file", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 0 0 0", "f 1//1 2//1 3//1"]),
      LIMITS,
    );
    expect(result.hasValidSourceNormals).toBe(false);
    expect(result.warnings.some((w) => w.code === "zero-length-normal")).toBe(true);
    expect(Array.from(result.normals.slice(0, 3))).toEqual(Array.from(result.flatNormals.slice(0, 3)));
  });

  it("flatNormals is always geometric even when a valid source normal points a different direction", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "vn 1 0 0", "f 1//1 2//1 3//1"]),
      LIMITS,
    );
    // The triangle lies in the XY plane, so its geometric normal is +/-Z, not the (unrelated) declared +X normal.
    expect(Array.from(result.normals.slice(0, 3))).toEqual([1, 0, 0]);
    expect(result.flatNormals[0]).toBeCloseTo(0, 5);
    expect(Math.abs(result.flatNormals[2])).toBeCloseTo(1, 5);
  });

  it("supports a mixed file where only some faces have normals", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 2 2 2",
        "v 3 2 2",
        "v 2 3 2",
        "vn 0 0 1",
        "f 1//1 2//1 3//1",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.hasValidSourceNormals).toBe(true);
    // Second triangle had no vn reference — its "smooth" normal must equal its own flat (geometric) normal.
    expect(Array.from(result.normals.slice(9, 18))).toEqual(Array.from(result.flatNormals.slice(9, 18)));
  });
});

describe("parseOBJForViewer — lines and points", () => {
  it("expands a polyline into consecutive rendered line segments with resolved positions", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 2 0 0", "l 1 2 3"]), LIMITS);
    expect(result.lineCount).toBe(2);
    expect(result.lineGeometry).toBeDefined();
    expect(result.lineGeometry!.length).toBe(2 * 6);
  });

  it("resolves negative-index line references", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "l -2 -1"]), LIMITS);
    expect(result.lineCount).toBe(1);
    expect(Array.from(result.lineGeometry!)).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it("rejects an out-of-range line reference", () => {
    expectOBJError(() => parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "l 1 5"]), LIMITS), "OBJ_INDEX_OUT_OF_RANGE");
  });

  it("resolves positive and negative point references", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "p 1 -1"]), LIMITS);
    expect(result.pointCount).toBe(2);
    expect(Array.from(result.pointGeometry!)).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it("enforces the line-segment safety ceiling", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxLineSegments: 1 };
    expectOBJError(
      () => parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 2 0 0", "l 1 2 3"]), limits),
      "OBJ_VIEWER_LINE_LIMIT",
    );
  });

  it("enforces the point safety ceiling", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxPoints: 1 };
    expectOBJError(() => parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "p 1 2"]), limits), "OBJ_VIEWER_POINT_LIMIT");
  });

  it("renders a file containing only lines and points, unlike the converter which rejects it", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "l 1 2", "p 1"]), LIMITS);
    expect(result.triangleCount).toBe(0);
    expect(result.lineCount).toBe(1);
    expect(result.pointCount).toBe(1);
    expect(result.segments).toHaveLength(0);
  });

  it("throws OBJ_VIEWER_NO_RENDERABLE_GEOMETRY for a file with no triangles, lines or points", () => {
    expectOBJError(() => parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0"]), LIMITS), "OBJ_VIEWER_NO_RENDERABLE_GEOMETRY");
  });
});

describe("parseOBJForViewer — bounds and rendering ranges", () => {
  it("triangle-only bounds cover just the mesh", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 2 0 0", "v 0 2 0", "f 1 2 3"]), LIMITS);
    expect(result.bounds.max).toEqual([2, 2, 0]);
  });

  it("overall bounds extend to include line/point geometry beyond the mesh", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "v 10 10 10", "f 1 2 3", "p 4"]),
      LIMITS,
    );
    expect(result.bounds.max).toEqual([10, 10, 10]);
  });

  it("each segment's bounds cover only that segment's own triangles", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "g a",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        "g b",
        "v 10 10 0",
        "v 11 10 0",
        "v 10 11 0",
        "f 4 5 6",
      ]),
      LIMITS,
    );
    expect(result.segments[0].bounds.max).toEqual([1, 1, 0]);
    expect(result.segments[1].bounds.min).toEqual([10, 10, 0]);
  });

  it("segment triangleStart/triangleCount describe correct, non-overlapping ranges", () => {
    const result = parseOBJForViewer(
      buildOBJText([
        "g a",
        "v 0 0 0",
        "v 2 0 0",
        "v 2 2 0",
        "v 0 2 0",
        "f 1 2 3 4",
        "g b",
        "v 10 10 0",
        "v 11 10 0",
        "v 10 11 0",
        "f 5 6 7",
      ]),
      LIMITS,
    );
    expect(result.segments[0].triangleStart).toBe(0);
    expect(result.segments[0].triangleCount).toBe(2);
    expect(result.segments[1].triangleStart).toBe(2);
    expect(result.segments[1].triangleCount).toBe(1);
    expect(result.triangleCount).toBe(3);
  });
});

describe("parseOBJForViewer — warnings", () => {
  it("warns about materials when mtllib/usemtl are present", () => {
    const result = parseOBJForViewer(
      buildOBJText(["mtllib a.mtl", "usemtl red", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]),
      LIMITS,
    );
    expect(result.warnings.some((w) => w.code === "materials-not-rendered")).toBe(true);
  });

  it("warns about texture coordinates when vt is present", () => {
    const result = parseOBJForViewer(
      buildOBJText(["vt 0.5 0.5", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]),
      LIMITS,
    );
    expect(result.warnings.some((w) => w.code === "textures-not-rendered")).toBe(true);
    expect(result.hasTextureCoordinates).toBe(true);
  });

  it("warns about the non-standard vertex-color extension", () => {
    const result = parseOBJForViewer(
      buildOBJText(["v 0 0 0 0.5 0.5 0.5", "v 1 0 0", "v 0 1 0", "f 1 2 3"]),
      LIMITS,
    );
    expect(result.warnings.some((w) => w.code === "vertex-colors-not-rendered")).toBe(true);
  });

  it("has no warnings for a clean minimal file", () => {
    const result = parseOBJForViewer(buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), LIMITS);
    expect(result.warnings).toEqual([]);
  });
});

describe("parseOBJForViewer — metadata safety ceilings", () => {
  it("throws OBJ_VIEWER_METADATA_LIMIT once total retained name bytes exceed the ceiling", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxMetadataBytes: 5 };
    expectOBJError(
      () => parseOBJForViewer(buildOBJText(["o abcdefghij", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), limits),
      "OBJ_VIEWER_METADATA_LIMIT",
    );
  });
});

describe("parseOBJViewerDocument / buildOBJViewerGeometry — staged pipeline", () => {
  it("splitting parse and geometry-building stages produces the same result as the convenience wrapper", () => {
    const text = buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]);
    const doc = parseOBJViewerDocument(text, LIMITS);
    const built = buildOBJViewerGeometry(doc, LIMITS);
    const direct = parseOBJForViewer(text, LIMITS);
    expect(built.triangleCount).toBe(direct.triangleCount);
    expect(Array.from(built.positions)).toEqual(Array.from(direct.positions));
  });

  it("rejects a triangle count above the shared safety ceiling", () => {
    const limits: OBJViewerLimits = { ...LIMITS, maxTriangles: 1 };
    expectOBJError(
      () =>
        parseOBJForViewer(
          buildOBJText(["v 0 0 0", "v 2 0 0", "v 2 2 0", "v 0 2 0", "f 1 2 3 4"]),
          limits,
        ),
      "OBJ_TRIANGLE_LIMIT_EXCEEDED",
    );
  });
});
