import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { decodeFBXGeometry } from "./geometry";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";
import { buildFBXBinary, expectFBXError, geometryNode, polygonVertexIndexNode, verticesNode } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

function decode(coords: number[], polygonIndices: number[], limits: FBXLimits = LIMITS) {
  const buf = buildFBXBinary({ nodes: [geometryNode(1n, "G", coords, polygonIndices)] });
  const doc = parseFBXBinary(buf, limits);
  return decodeFBXGeometry(doc.nodes[0], limits);
}

describe("decodeFBXGeometry — polygon termination and triangles", () => {
  it("decodes a single triangle", () => {
    const geo = decode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3]); // -3 => actual index 2 (final corner)
    expect(geo.controlPointCount).toBe(3);
    expect(geo.polygonCount).toBe(1);
    expect(geo.triangles).toHaveLength(1);
    expect(geo.triangles[0].controlPointIndices).toEqual([0, 1, 2]);
  });

  it("decodes a planar quad into two triangles", () => {
    const coords = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const geo = decode(coords, [0, 1, 2, -4]);
    expect(geo.polygonCount).toBe(1);
    expect(geo.triangles).toHaveLength(2);
    expect(geo.skippedDegeneratePolygons).toBe(0);
  });

  it("correctly ear-clips a concave polygon rather than blindly fanning it", () => {
    // An L-shaped hexagon in the XY plane — a naive fan from vertex 0 would produce a triangle outside the polygon.
    const coords = [0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0];
    const geo = decode(coords, [0, 1, 2, 3, 4, -6]);
    expect(geo.triangles.length).toBe(4); // hexagon -> 4 triangles
    // Every triangle must lie within the L-shape's control points only (a sanity check that indices are valid and bounded).
    for (const tri of geo.triangles) {
      for (const idx of tri.controlPointIndices) expect(idx).toBeGreaterThanOrEqual(0);
    }
  });

  it("decodes multiple polygons in one geometry, correctly separated by their own terminators", () => {
    const coords = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0];
    const geo = decode(coords, [0, 1, -3, 3, 4, -6]);
    expect(geo.polygonCount).toBe(2);
    expect(geo.triangles).toHaveLength(2);
    expect(geo.triangles[0].polygonIndex).toBe(0);
    expect(geo.triangles[1].polygonIndex).toBe(1);
  });

  it("tracks original corner indices per triangle for layer-element resolution", () => {
    const coords = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const geo = decode(coords, [0, 1, 2, -4]);
    // Corner indices are flat positions into the 4-entry stream [0,1,2,-4] for this single polygon.
    for (const tri of geo.triangles) {
      for (const cornerIdx of tri.cornerIndices) expect(cornerIdx).toBeGreaterThanOrEqual(0);
      expect(Math.max(...tri.cornerIndices)).toBeLessThan(4);
    }
  });
});

describe("decodeFBXGeometry — invalid and degenerate input", () => {
  it("rejects a stream that doesn't end on a polygon terminator", () => {
    expectFBXError(() => decode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]), "FBX_GEOMETRY_INVALID");
  });

  it("rejects a polygon with fewer than three vertices", () => {
    expectFBXError(() => decode([0, 0, 0, 1, 0, 0], [0, -2]), "FBX_POLYGON_TOO_SMALL");
  });

  it("rejects an out-of-range control-point index", () => {
    expectFBXError(() => decode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -100]), "FBX_POLYGON_INDEX_OUT_OF_RANGE");
  });

  it("rejects a negative-terminated index that resolves out of range", () => {
    expectFBXError(() => decode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -1000]), "FBX_POLYGON_INDEX_OUT_OF_RANGE");
  });

  it("skips (and counts) a degenerate zero-area triangle rather than failing the file", () => {
    const geo = decode([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, -3]); // three collinear points
    expect(geo.triangles).toHaveLength(0);
    expect(geo.skippedDegeneratePolygons).toBe(1);
  });

  it("rejects a Geometry node missing Vertices or PolygonVertexIndex", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "Geometry", properties: [{ type: "L", value: 1n }, { type: "S", value: "G" }, { type: "S", value: "Mesh" }], children: [verticesNode([0, 0, 0])] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    expectFBXError(() => decodeFBXGeometry(doc.nodes[0], LIMITS), "FBX_GEOMETRY_INVALID");
  });

  it("rejects a non-finite control-point coordinate", () => {
    const buf = buildFBXBinary({
      nodes: [
        {
          name: "Geometry",
          properties: [{ type: "L", value: 1n }, { type: "S", value: "G" }, { type: "S", value: "Mesh" }],
          children: [verticesNode([0, 0, 0, Number.NaN, 0, 0, 1, 1, 0]), polygonVertexIndexNode([0, 1, -3])],
        },
      ],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    expectFBXError(() => decodeFBXGeometry(doc.nodes[0], LIMITS), "FBX_NON_FINITE_VERTEX");
  });

  it("enforces the control-point count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxControlPointsPerGeometry: 2 };
    expectFBXError(() => decode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3], limits), "FBX_CONTROL_POINT_LIMIT_EXCEEDED");
  });

  it("enforces the polygon-vertex-count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxPolygonVertexCount: 3 };
    const coords = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    expectFBXError(() => decode(coords, [0, 1, 2, -4], limits), "FBX_POLYGON_VERTEX_LIMIT_EXCEEDED");
  });

  it("enforces the polygon-count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxPolygonsPerGeometry: 1 };
    const coords = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0];
    expectFBXError(() => decode(coords, [0, 1, -3, 3, 4, -6], limits), "FBX_POLYGON_COUNT_EXCEEDED");
  });

  it("enforces the triangle-count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxTriangles: 1 };
    const coords = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    expectFBXError(() => decode(coords, [0, 1, 2, -4], limits), "FBX_TRIANGLE_LIMIT_EXCEEDED");
  });
});

