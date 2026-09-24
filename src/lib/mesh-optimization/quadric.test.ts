import { describe, expect, it } from "vitest";
import { addQuadric, evaluateQuadric, planeQuadric, solveOptimalPosition, triangleQuadric, ZERO_QUADRIC, type Quadric } from "./quadric";

describe("planeQuadric", () => {
  it("builds a symmetric quadric (the 4x4 matrix planeQuadric represents is always symmetric by construction, pp^T)", () => {
    const q = planeQuadric(0, 0, 1, 0); // the z=0 plane
    // Represented as the 10 unique upper-triangular entries of a symmetric
    // 4x4 matrix [a2,ab,ac,ad,b2,bc,bd,c2,cd,d2] — symmetry is structural
    // (there is no separate lower-triangular storage to disagree with it),
    // so this test asserts the specific values a normalized [0,0,1,0]
    // plane produces are consistent with pp^T.
    expect(q.a2).toBeCloseTo(0, 10);
    expect(q.b2).toBeCloseTo(0, 10);
    expect(q.c2).toBeCloseTo(1, 10);
    expect(q.ab).toBeCloseTo(0, 10);
    expect(q.ac).toBeCloseTo(0, 10);
    expect(q.bc).toBeCloseTo(0, 10);
  });

  it("rejects a non-finite plane input", () => {
    expect(() => planeQuadric(NaN, 0, 1, 0)).toThrow();
    expect(() => planeQuadric(0, Infinity, 1, 0)).toThrow();
  });

  it("rejects a degenerate (zero-length) normal", () => {
    expect(() => planeQuadric(0, 0, 0, 5)).toThrow();
  });
});

describe("evaluateQuadric — plane distance error", () => {
  it("is zero for a point exactly on the plane", () => {
    const q = planeQuadric(0, 0, 1, 0); // z=0 plane
    expect(evaluateQuadric(q, [3, -7, 0])).toBeCloseTo(0, 8);
  });

  it("is positive for a point off the plane", () => {
    const q = planeQuadric(0, 0, 1, 0); // z=0 plane
    expect(evaluateQuadric(q, [0, 0, 5])).toBeGreaterThan(0);
  });

  it("grows with squared distance from the plane (quadric error is the squared perpendicular distance)", () => {
    const q = planeQuadric(0, 0, 1, 0);
    const near = evaluateQuadric(q, [0, 0, 1]);
    const far = evaluateQuadric(q, [0, 0, 2]);
    expect(far).toBeCloseTo(4 * near, 6); // distance doubles -> squared error quadruples
  });
});

describe("addQuadric", () => {
  it("sums two quadrics component-wise (fundamental QEM operation: a vertex's quadric is the sum of its incident planes')", () => {
    const q1 = planeQuadric(1, 0, 0, 0); // x=0 plane
    const q2 = planeQuadric(0, 1, 0, 0); // y=0 plane
    const sum = addQuadric(q1, q2);
    expect(sum.a2).toBeCloseTo(1, 10);
    expect(sum.b2).toBeCloseTo(1, 10);
    expect(sum.c2).toBeCloseTo(0, 10);
  });

  it("adding the zero quadric is a no-op", () => {
    const q = planeQuadric(0, 0, 1, -2);
    const sum = addQuadric(q, ZERO_QUADRIC);
    // Numeric equality, not strict object equality: IEEE754 can produce a
    // sign-flipped zero (-0 vs 0) here, which is mathematically identical
    // (-0 === 0) but would fail a literal deep-equal check.
    for (const key of Object.keys(q) as (keyof Quadric)[]) {
      expect(sum[key]).toBeCloseTo(q[key], 12);
    }
  });

  it("error at a point for a summed quadric equals the sum of each plane's own error there (linearity)", () => {
    const q1 = planeQuadric(1, 0, 0, 0);
    const q2 = planeQuadric(0, 1, 0, 0);
    const sum = addQuadric(q1, q2);
    const p: [number, number, number] = [3, 4, 5];
    expect(evaluateQuadric(sum, p)).toBeCloseTo(evaluateQuadric(q1, p) + evaluateQuadric(q2, p), 8);
  });
});

describe("triangleQuadric", () => {
  it("produces zero error for any point on the triangle's own plane", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    const q = triangleQuadric(p0, p1, p2);
    expect(evaluateQuadric(q, [0.25, 0.25, 0])).toBeCloseTo(0, 6);
  });

  it("rejects a degenerate (zero-area) triangle", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [2, 0, 0]; // collinear
    expect(() => triangleQuadric(p0, p1, p2)).toThrow();
  });
});

describe("solveOptimalPosition", () => {
  it("solves a finite optimal position at the intersection of three independent planes", () => {
    // Three mutually perpendicular planes through (1,2,3): x=1, y=2, z=3.
    const q = addQuadric(addQuadric(planeQuadric(1, 0, 0, -1), planeQuadric(0, 1, 0, -2)), planeQuadric(0, 0, 1, -3));
    const result = solveOptimalPosition(q);
    expect(result.ok).toBe(true);
    expect(result.position![0]).toBeCloseTo(1, 6);
    expect(result.position![1]).toBeCloseTo(2, 6);
    expect(result.position![2]).toBeCloseTo(3, 6);
  });

  it("falls back (not ok) for a singular quadric — e.g. a single plane's quadric alone has no unique minimizer", () => {
    const q = planeQuadric(0, 0, 1, 0);
    const result = solveOptimalPosition(q);
    expect(result.ok).toBe(false);
    expect(result.position).toBeNull();
  });

  it("falls back for the zero quadric (fully singular, no constraint at all)", () => {
    const result = solveOptimalPosition(ZERO_QUADRIC);
    expect(result.ok).toBe(false);
  });
});
