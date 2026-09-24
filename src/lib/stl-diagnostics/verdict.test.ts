import { describe, expect, it } from "vitest";
import { computeVerdict, computeSlicerRisk } from "./verdict";

const BASE = {
  validTriangleCount: 12,
  boundaryEdgeCount: 0,
  nonManifoldEdgeCount: 0,
  windingConflictEdgeCount: 0,
  sameWindingDuplicateFaceCount: 0,
  reverseWindingDuplicateFaceCount: 0,
  selfIntersections: { status: "completed" as const, intersectingPairCount: 0 },
};

describe("computeVerdict", () => {
  it("no valid triangles is invalid-topology", () => {
    const result = computeVerdict({ ...BASE, validTriangleCount: 0 });
    expect(result.verdict).toBe("invalid-topology");
    expect(result.reasonCodes).toEqual(["no-valid-triangles"]);
  });

  it("a clean, fully-checked mesh is watertight", () => {
    const result = computeVerdict(BASE);
    expect(result.verdict).toBe("watertight");
    expect(result.reasonCodes).toEqual(["all-checks-passed"]);
  });

  it("any boundary edge makes it not-watertight", () => {
    const result = computeVerdict({ ...BASE, boundaryEdgeCount: 4 });
    expect(result.verdict).toBe("not-watertight");
    expect(result.reasonCodes).toContain("has-boundary-edges");
  });

  it("any non-manifold edge makes it not-watertight", () => {
    const result = computeVerdict({ ...BASE, nonManifoldEdgeCount: 1 });
    expect(result.verdict).toBe("not-watertight");
    expect(result.reasonCodes).toContain("has-non-manifold-edges");
  });

  it("any winding conflict makes it not-watertight", () => {
    const result = computeVerdict({ ...BASE, windingConflictEdgeCount: 1 });
    expect(result.verdict).toBe("not-watertight");
    expect(result.reasonCodes).toContain("has-winding-conflicts");
  });

  it("any duplicate face makes it not-watertight", () => {
    const result = computeVerdict({ ...BASE, sameWindingDuplicateFaceCount: 1 });
    expect(result.verdict).toBe("not-watertight");
    expect(result.reasonCodes).toContain("has-duplicate-faces");
  });

  it("a found self-intersection makes it not-watertight, under the declared strict policy", () => {
    const result = computeVerdict({ ...BASE, selfIntersections: { status: "completed", intersectingPairCount: 3 } });
    expect(result.verdict).toBe("not-watertight");
    expect(result.reasonCodes).toContain("self-intersections-found");
  });

  it("an incomplete self-intersection check with no other definite failure is indeterminate, never a silent pass", () => {
    const result = computeVerdict({ ...BASE, selfIntersections: { status: "not-checked", intersectingPairCount: 0 } });
    expect(result.verdict).toBe("indeterminate");
    expect(result.reasonCodes).toEqual(["self-intersections-not-checked"]);
  });

  it("reports every applicable definite-failure reason at once, not just the first", () => {
    const result = computeVerdict({ ...BASE, boundaryEdgeCount: 2, nonManifoldEdgeCount: 1 });
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["has-boundary-edges", "has-non-manifold-edges"]));
  });
});

describe("computeSlicerRisk", () => {
  const CLEAN = {
    verdict: "watertight" as const,
    boundaryEdgeCount: 0,
    closedLoopBoundaryCount: 0,
    nonManifoldEdgeCount: 0,
    windingConflictEdgeCount: 0,
    inwardShellCount: 0,
    shellCount: 1,
    degenerateTriangleCount: 0,
    selfIntersections: { status: "completed" as const, intersectingPairCount: 0, involvedTriangleCount: 0, samplePairs: [] },
    sameWindingDuplicateFaceCount: 0,
    reverseWindingDuplicateFaceCount: 0,
  };

  it("a fully clean, watertight, single-shell mesh has zero risk flags", () => {
    expect(computeSlicerRisk(CLEAN)).toEqual([]);
  });

  it("flags multiple shells as informational, not a risk", () => {
    const flags = computeSlicerRisk({ ...CLEAN, shellCount: 3 });
    expect(flags.find((f) => f.code === "multiple-shells")?.severity).toBe("info");
  });

  it("flags an inward shell as a warning", () => {
    const flags = computeSlicerRisk({ ...CLEAN, inwardShellCount: 1 });
    expect(flags.find((f) => f.code === "inward-shells")?.severity).toBe("warning");
  });

  it("flags a not-watertight verdict as a risk", () => {
    const flags = computeSlicerRisk({ ...CLEAN, verdict: "not-watertight", boundaryEdgeCount: 4, closedLoopBoundaryCount: 1 });
    expect(flags.find((f) => f.code === "not-watertight")?.severity).toBe("risk");
    expect(flags.find((f) => f.code === "has-holes")?.severity).toBe("risk");
  });
});
