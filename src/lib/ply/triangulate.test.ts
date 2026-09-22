import { describe, expect, it } from "vitest";
import { triangulatePolygon } from "./triangulate";
import { expectPLYError } from "./test-fixtures";

const MAX_ITER = 10_000;

describe("triangulatePolygon (PLY wrapper)", () => {
  it("returns a triangle face unchanged", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toEqual([[0, 1, 2]]);
  });

  it("fans a convex quad into two triangles", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toHaveLength(2);
  });

  it("ear-clips a concave L-shaped hexagon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toHaveLength(4);
  });

  it("rejects a face with fewer than three vertices as PLY_FACE_TOO_SMALL", () => {
    expectPLYError(
      () =>
        triangulatePolygon(
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          MAX_ITER,
        ),
      "PLY_FACE_TOO_SMALL",
    );
  });

  it("rejects a degenerate (zero-area) polygon as PLY_POLYGON_DEGENERATE", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    expectPLYError(() => triangulatePolygon(vertices, MAX_ITER), "PLY_POLYGON_DEGENERATE");
  });

  it("rejects a severely non-planar polygon as PLY_POLYGON_NON_PLANAR", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 5],
      [0, 1, 0],
    ];
    expectPLYError(() => triangulatePolygon(vertices, MAX_ITER), "PLY_POLYGON_NON_PLANAR");
  });

  it("rejects a self-intersecting (bowtie) polygon as PLY_POLYGON_SELF_INTERSECTING", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 4, 0],
      [4, 0, 0],
      [0, 4, 0],
    ];
    expectPLYError(() => triangulatePolygon(vertices, MAX_ITER), "PLY_POLYGON_SELF_INTERSECTING");
  });

  it("fails safely once the iteration ceiling is reached, as PLY_TRIANGULATION_FAILED", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [2, 1, 0],
      [4, 4, 0],
    ];
    expectPLYError(() => triangulatePolygon(vertices, 0), "PLY_TRIANGULATION_FAILED");
  });
});
