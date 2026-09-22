import { describe, expect, it } from "vitest";
import { triangulatePolygon } from "./triangulate";
import { expectOBJError } from "./test-fixtures";

const MAX_ITER = 10_000;

function polygonArea(vertices: [number, number, number][], triangles: [number, number, number][]): number {
  let total = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    total += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return total;
}

describe("triangulatePolygon", () => {
  it("returns a triangle face unchanged", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toEqual([[0, 1, 2]]);
  });

  it("fans a convex quad into two triangles covering the full area", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toHaveLength(2);
    expect(polygonArea(vertices, result.triangles)).toBeCloseTo(4, 5);
  });

  it("fans a convex pentagon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [3, 1.5, 0],
      [1, 3, 0],
      [-1, 1.5, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toHaveLength(3);
  });

  it("ear-clips a concave quad (dart) without corrupted output", () => {
    // Reflex at D — naive fan-from-vertex-0 here would emit triangle A-C-D
    // with an INVERTED (wrong-sign) orientation, since diagonal A-C exits
    // the polygon through the notch at D. (Total signed area alone can't
    // distinguish a correct triangulation from a naive one: by the
    // shoelace identity, ANY vertex-fan's signed-area sum equals the
    // polygon's total area regardless of whether individual triangles are
    // valid — so this test checks per-triangle orientation instead.)
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [6, 3, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.triangles).toHaveLength(2);
    expect(polygonArea(vertices, result.triangles)).toBeCloseTo(35, 5);

    // Every ear-clipped triangle must share the polygon's own orientation —
    // ear selection only ever accepts a convex (correctly-oriented) tip.
    const [a, b, c] = [vertices[0], vertices[1], vertices[2]];
    const polygonOrientationSign = Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    for (const [ia, ib, ic] of result.triangles) {
      const [ta, tb, tc] = [vertices[ia], vertices[ib], vertices[ic]];
      const sign = Math.sign((tb[0] - ta[0]) * (tc[1] - ta[1]) - (tb[1] - ta[1]) * (tc[0] - ta[0]));
      expect(sign).toBe(polygonOrientationSign);
    }

    // Confirms this fixture is a genuinely adversarial case: naive
    // fan-from-vertex-0 WOULD include an inverted triangle (A, C, D).
    const [fa, fc, fd] = [vertices[0], vertices[2], vertices[3]];
    const fanSign = Math.sign((fc[0] - fa[0]) * (fd[1] - fa[1]) - (fc[1] - fa[1]) * (fd[0] - fa[0]));
    expect(fanSign).not.toBe(polygonOrientationSign);
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
    // L-shape area = 4*2 + 2*2 = 12
    expect(polygonArea(vertices, result.triangles)).toBeCloseTo(12, 5);
  });

  it("preserves clockwise winding", () => {
    const ccw: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    const cw: [number, number, number][] = [ccw[0], ccw[3], ccw[2], ccw[1]];

    const ccwResult = triangulatePolygon(ccw, MAX_ITER);
    const cwResult = triangulatePolygon(cw, MAX_ITER);

    // Winding is preserved by never reordering vertices — so the two
    // results' triangle normals must point in opposite directions.
    const normalOf = (verts: typeof ccw, tri: [number, number, number]) => {
      const [a, b, c] = [verts[tri[0]], verts[tri[1]], verts[tri[2]]];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      return ux * vy - uy * vx;
    };
    expect(Math.sign(normalOf(ccw, ccwResult.triangles[0]))).toBe(1);
    expect(Math.sign(normalOf(cw, cwResult.triangles[0]))).toBe(-1);
  });

  it("handles a collinear point on a convex polygon's edge", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [0.5, 0, 0], // collinear with its neighbors
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(polygonArea(vertices, result.triangles)).toBeCloseTo(1, 5);
  });

  it("rejects a degenerate (zero-area) polygon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    expectOBJError(() => triangulatePolygon(vertices, MAX_ITER), "OBJ_POLYGON_DEGENERATE");
  });

  it("rejects a severely non-planar polygon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 5],
      [0, 1, 0],
    ];
    expectOBJError(() => triangulatePolygon(vertices, MAX_ITER), "OBJ_POLYGON_NON_PLANAR");
  });

  it("warns (but succeeds) on a mildly non-planar polygon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0.15],
      [0, 10, 0],
    ];
    const result = triangulatePolygon(vertices, MAX_ITER);
    expect(result.nonPlanarWarning).toBe(true);
  });

  it("rejects a self-intersecting (bowtie) polygon", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 4, 0],
      [4, 0, 0],
      [0, 4, 0],
    ];
    expectOBJError(() => triangulatePolygon(vertices, MAX_ITER), "OBJ_POLYGON_SELF_INTERSECTING");
  });

  it("fails safely once the iteration ceiling is reached", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [2, 1, 0],
      [4, 4, 0],
    ];
    expectOBJError(() => triangulatePolygon(vertices, 0), "OBJ_TRIANGULATION_FAILED");
  });

  it("produces deterministic output across repeated runs", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ];
    const first = triangulatePolygon(vertices, MAX_ITER);
    const second = triangulatePolygon(vertices, MAX_ITER);
    expect(second.triangles).toEqual(first.triangles);
  });

  it("rejects a face with fewer than three vertices", () => {
    expectOBJError(
      () =>
        triangulatePolygon(
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          MAX_ITER,
        ),
      "OBJ_FACE_TOO_SMALL",
    );
  });
});
