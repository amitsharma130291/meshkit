import { describe, expect, it } from "vitest";
import { CandidatePairLimitExceededError, findCandidatePairs, type TriangleBox } from "./spatial-index";

const LIMITS = { targetTrianglesPerCell: 4, maxGridCells: 10_000, maxCandidatePairs: 100_000 };

function box(index: number, min: [number, number, number], max: [number, number, number]): TriangleBox {
  return { triangleIndex: index, min, max };
}

describe("findCandidatePairs", () => {
  it("returns no pairs for fewer than 2 boxes", () => {
    expect(findCandidatePairs([], LIMITS)).toEqual([]);
    expect(findCandidatePairs([box(0, [0, 0, 0], [1, 1, 1])], LIMITS)).toEqual([]);
  });

  it("finds a candidate pair for two overlapping boxes", () => {
    const pairs = findCandidatePairs([box(0, [0, 0, 0], [1, 1, 1]), box(1, [0.5, 0.5, 0.5], [1.5, 1.5, 1.5])], LIMITS);
    expect(pairs).toEqual([[0, 1]]);
  });

  it("never reports the same pair twice even when boxes co-occur in multiple cells", () => {
    // A box spanning many cells alongside a small box inside it should still yield exactly one pair.
    const pairs = findCandidatePairs([box(0, [0, 0, 0], [10, 10, 10]), box(1, [1, 1, 1], [2, 2, 2])], { ...LIMITS, targetTrianglesPerCell: 1 });
    expect(pairs).toEqual([[0, 1]]);
  });

  it("is a superset that still excludes boxes far enough apart to land in disjoint cells, once enough boxes make the grid fine-grained", () => {
    // Grid resolution is derived from box COUNT (targetTrianglesPerCell),
    // so with only 2 boxes total the grid is deliberately coarse (~1-2
    // cells across the whole span) and may not separate even a distant
    // pair — that's expected for a broad phase on a near-empty scene, not
    // a bug (a real mesh's hundreds/thousands of triangles produce a much
    // finer grid). Filling space with many small, clustered boxes gives
    // the grid enough resolution to actually separate a genuinely distant
    // pair, which is the property this test verifies.
    const clustered: TriangleBox[] = [];
    for (let i = 0; i < 50; i++) {
      const x = (i % 5) * 0.02;
      const y = (Math.floor(i / 5) % 5) * 0.02;
      const z = Math.floor(i / 25) * 0.02;
      clustered.push(box(i, [x, y, z], [x + 0.01, y + 0.01, z + 0.01]));
    }
    const farBox = box(999, [100, 100, 100], [100.1, 100.1, 100.1]);
    const pairs = findCandidatePairs([...clustered, farBox], { ...LIMITS, targetTrianglesPerCell: 1 });
    expect(pairs.some(([a, b]) => a === 999 || b === 999)).toBe(false);
  });

  it("throws CandidatePairLimitExceededError rather than silently truncating when the ceiling is hit", () => {
    const boxes: TriangleBox[] = Array.from({ length: 20 }, (_, i) => box(i, [0, 0, 0], [1, 1, 1])); // all mutually overlapping -> C(20,2)=190 pairs
    expect(() => findCandidatePairs(boxes, { ...LIMITS, maxCandidatePairs: 5 })).toThrow(CandidatePairLimitExceededError);
  });
});
