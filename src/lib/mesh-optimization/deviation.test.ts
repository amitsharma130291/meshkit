import { describe, expect, it } from "vitest";
import { closestPointOnTriangle, sampleDeviation, type SurfaceSample } from "./deviation";

const DEVIATION_LIMITS = { maxSamples: 10_000, maxGridCells: 100_000 };

describe("closestPointOnTriangle", () => {
  it("returns the point itself when it's already on the triangle's plane and inside it", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    const closest = closestPointOnTriangle([0.25, 0.25, 0], p0, p1, p2);
    expect(closest[0]).toBeCloseTo(0.25, 6);
    expect(closest[1]).toBeCloseTo(0.25, 6);
    expect(closest[2]).toBeCloseTo(0, 6);
  });

  it("projects straight down onto the plane for a point directly above the triangle's interior", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    const closest = closestPointOnTriangle([0.25, 0.25, 5], p0, p1, p2);
    expect(closest[2]).toBeCloseTo(0, 6);
  });

  it("clamps to the nearest vertex for a point beyond a corner", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    const closest = closestPointOnTriangle([-5, -5, 0], p0, p1, p2);
    expect(closest).toEqual(p0);
  });
});

function surfaceOf(triangles: [number, number, number][][]): SurfaceSample {
  const positions: number[] = [];
  const triangleVertexIds: number[] = [];
  for (const tri of triangles) {
    for (const p of tri) {
      triangleVertexIds.push(positions.length / 3);
      positions.push(...p);
    }
  }
  return { positions: Float32Array.from(positions), triangleVertexIds: Int32Array.from(triangleVertexIds), triangleCount: triangles.length };
}

describe("sampleDeviation", () => {
  it("reports zero deviation between a mesh and an identical copy of itself", () => {
    const flat: [number, number, number][][] = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ];
    const result = sampleDeviation(surfaceOf(flat), surfaceOf(flat), DEVIATION_LIMITS);
    expect(result.completed).toBe(true);
    expect(result.maxDeviation).toBeCloseTo(0, 6);
    expect(result.meanDeviation).toBeCloseTo(0, 6);
    expect(result.rmsDeviation).toBeCloseTo(0, 6);
    expect(result.sampleCount).toBeGreaterThan(0);
  });

  it("reports a positive deviation matching the known offset between two parallel planes", () => {
    const original: [number, number, number][][] = [
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
      [
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
    ];
    const offset: [number, number, number][][] = original.map((tri) => tri.map(([x, y, z]) => [x, y, z + 2] as [number, number, number]));
    const result = sampleDeviation(surfaceOf(original), surfaceOf(offset), DEVIATION_LIMITS);
    expect(result.completed).toBe(true);
    expect(result.maxDeviation).toBeCloseTo(2, 4);
    expect(result.meanDeviation).toBeCloseTo(2, 4);
  });

  it("marks the result incomplete (not silently truncated as if complete) when the sample ceiling is hit", () => {
    const many: [number, number, number][][] = [];
    for (let i = 0; i < 50; i++) {
      many.push([
        [i, 0, 0],
        [i + 1, 0, 0],
        [i, 1, 0],
      ]);
    }
    const result = sampleDeviation(surfaceOf(many), surfaceOf(many), { maxSamples: 10, maxGridCells: 100_000 });
    expect(result.completed).toBe(false);
    expect(result.incompleteDueToSafetyCeiling).toBe(true);
    expect(result.sampleCount).toBeLessThanOrEqual(10);
  });
});
