import { describe, expect, it } from "vitest";
import { triangulatePolygon } from "./triangulate";
import {
  FaceTooSmallError,
  PolygonDegenerateError,
  PolygonNonPlanarError,
  PolygonSelfIntersectingError,
  TriangulationFailedError,
} from "./errors";

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

describe("triangulatePolygon (canonical, format-neutral)", () => {
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
    expect(polygonArea(vertices, result.triangles)).toBeCloseTo(12, 5);
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

  it("throws the generic FaceTooSmallError, not a domain-specific one", () => {
    expect(() =>
      triangulatePolygon(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        MAX_ITER,
      ),
    ).toThrow(FaceTooSmallError);
  });

  it("throws the generic PolygonDegenerateError, not a domain-specific one", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    expect(() => triangulatePolygon(vertices, MAX_ITER)).toThrow(PolygonDegenerateError);
  });

  it("throws the generic PolygonNonPlanarError, not a domain-specific one", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 5],
      [0, 1, 0],
    ];
    expect(() => triangulatePolygon(vertices, MAX_ITER)).toThrow(PolygonNonPlanarError);
  });

  it("throws the generic PolygonSelfIntersectingError, not a domain-specific one", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 4, 0],
      [4, 0, 0],
      [0, 4, 0],
    ];
    expect(() => triangulatePolygon(vertices, MAX_ITER)).toThrow(PolygonSelfIntersectingError);
  });

  it("throws the generic TriangulationFailedError once the iteration ceiling is reached", () => {
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [2, 1, 0],
      [4, 4, 0],
    ];
    expect(() => triangulatePolygon(vertices, 0)).toThrow(TriangulationFailedError);
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
});
