import { describe, expect, it } from "vitest";
import { resolveTargetTriangleCount } from "./types";

describe("resolveTargetTriangleCount", () => {
  it("computes a percentage-mode target as the REDUCTION percentage, not retained percentage", () => {
    expect(resolveTargetTriangleCount(1000, { mode: "percentage", value: 25 }, 4)).toBe(750);
    expect(resolveTargetTriangleCount(1000, { mode: "percentage", value: 75 }, 4)).toBe(250);
  });

  it("uses a triangle-count target directly", () => {
    expect(resolveTargetTriangleCount(1000, { mode: "triangle-count", value: 300 }, 4)).toBe(300);
  });

  it("never resolves below the safety floor", () => {
    expect(resolveTargetTriangleCount(1000, { mode: "triangle-count", value: 1 }, 50)).toBe(50);
  });

  it("never resolves above the source triangle count", () => {
    expect(resolveTargetTriangleCount(1000, { mode: "triangle-count", value: 5000 }, 4)).toBe(1000);
  });
});
