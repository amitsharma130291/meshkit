import { describe, expect, it } from "vitest";
import { determineOutcome } from "./outcome";
import type { DiagnosticsSummary } from "./types";

function summary(overrides: Partial<DiagnosticsSummary> = {}): DiagnosticsSummary {
  return {
    verdict: "watertight",
    triangleCount: 12,
    validTriangleCount: 12,
    uniqueVertexPositionCount: 8,
    boundaryEdgeCount: 0,
    nonManifoldEdgeCount: 0,
    windingConflictEdgeCount: 0,
    duplicateFaceCount: 0,
    degenerateTriangleCount: 0,
    shellCount: 1,
    inwardShellCount: 0,
    selfIntersectionStatus: "completed",
    selfIntersectionCount: 0,
    ...overrides,
  };
}

describe("determineOutcome", () => {
  it("an already-clean mesh with nothing to fix is unchanged", () => {
    const outcome = determineOutcome({ before: summary(), after: summary(), skippedOperations: [], unresolvedProblems: [] });
    expect(outcome).toBe("unchanged");
  });

  it("a broken mesh fully fixed, with a completed self-intersection check, is fully-repaired", () => {
    const before = summary({ verdict: "not-watertight", boundaryEdgeCount: 4 });
    const after = summary();
    const outcome = determineOutcome({ before, after, skippedOperations: [], unresolvedProblems: [] });
    expect(outcome).toBe("fully-repaired");
  });

  it("caps the outcome at 'improved' even with zero remaining problems, when the self-intersection check itself did not complete", () => {
    const before = summary({ verdict: "not-watertight", boundaryEdgeCount: 4 });
    const after = summary({ verdict: "watertight", selfIntersectionStatus: "not-checked" });
    const outcome = determineOutcome({ before, after, skippedOperations: [], unresolvedProblems: [] });
    expect(outcome).not.toBe("fully-repaired");
  });

  it("some improvement with no explicit skips is 'improved'", () => {
    const before = summary({ verdict: "not-watertight", boundaryEdgeCount: 8 });
    const after = summary({ verdict: "not-watertight", boundaryEdgeCount: 4 });
    const outcome = determineOutcome({ before, after, skippedOperations: [], unresolvedProblems: [] });
    expect(outcome).toBe("improved");
  });

  it("improvement with an explicit skip or unresolved problem is 'partially-repaired'", () => {
    const before = summary({ verdict: "not-watertight", boundaryEdgeCount: 8 });
    const after = summary({ verdict: "not-watertight", boundaryEdgeCount: 4 });
    const outcome = determineOutcome({ before, after, skippedOperations: [{ operation: "fill-eligible-holes", reason: "test" }], unresolvedProblems: [] });
    expect(outcome).toBe("partially-repaired");
  });

  it("no improvement at all on a broken mesh is unable-to-repair-safely", () => {
    const before = summary({ verdict: "not-watertight", nonManifoldEdgeCount: 3 });
    const after = summary({ verdict: "not-watertight", nonManifoldEdgeCount: 3 });
    const outcome = determineOutcome({ before, after, skippedOperations: [], unresolvedProblems: ["3 non-manifold edges left unresolved."] });
    expect(outcome).toBe("unable-to-repair-safely");
  });

  it("degenerate-triangle reduction alone counts as improvement even with zero topology-count change", () => {
    const before = summary({ degenerateTriangleCount: 5 });
    const after = summary({ degenerateTriangleCount: 0 });
    const outcome = determineOutcome({ before, after, skippedOperations: [], unresolvedProblems: [] });
    expect(outcome).toBe("improved");
  });
});
