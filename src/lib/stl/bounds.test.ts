import { describe, expect, it } from "vitest";
import { computeBounds } from "./bounds";

describe("computeBounds", () => {
  it("computes min/max/size/center for a simple triangle", () => {
    // A single triangle spanning x:[0,1] y:[0,1] z:[0,0]
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bounds = computeBounds(positions);

    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([1, 1, 0]);
    expect(bounds.size).toEqual([1, 1, 0]);
    expect(bounds.center).toEqual([0.5, 0.5, 0]);
  });

  it("computes bounds across multiple triangles offset in space", () => {
    const positions = new Float32Array([
      -2, -2, -2, -1, -2, -2, -1.5, -1, -2, // triangle 1
      3, 4, 5, 3, 4, 5, 3, 4, 5, // triangle 2 (degenerate, all same point)
    ]);
    const bounds = computeBounds(positions);

    expect(bounds.min).toEqual([-2, -2, -2]);
    expect(bounds.max).toEqual([3, 4, 5]);
    expect(bounds.size).toEqual([5, 6, 7]);
    expect(bounds.center).toEqual([0.5, 1, 1.5]);
  });

  it("returns a zero-sized box for an empty buffer instead of Infinity", () => {
    const bounds = computeBounds(new Float32Array(0));
    expect(bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] });
  });

  it("handles a flat (zero-depth) model without breaking size/center", () => {
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 1, 2, 0]);
    const bounds = computeBounds(positions);
    expect(bounds.size[2]).toBe(0);
    expect(bounds.center[2]).toBe(0);
  });
});
