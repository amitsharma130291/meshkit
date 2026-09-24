import { describe, expect, it } from "vitest";
import { determineOutcome } from "./outcome";
import type { DiagnosticsSummary } from "./types";

function summary(overrides: Partial<DiagnosticsSummary> = {}): DiagnosticsSummary {
  return {
    verdict: "watertight",
    triangleCount: 100,
    validTriangleCount: 100,
    uniqueVertexPositionCount: 52,
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

describe("determineOutcome — target-achieved", () => {
  it("reports target-achieved when the target is met, invariants hold, and verification completed", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("target-achieved");
  });

  it("never reports target-achieved if the self-intersection check on the OUTPUT didn't complete", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400, selfIntersectionStatus: "not-checked" });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).not.toBe("target-achieved");
  });
});

describe("determineOutcome — safety invariant violations never silently pass as success", () => {
  it("reports verification-failed if a watertight input became non-watertight (must never happen, but must never be hidden if it somehow did)", () => {
    const before = summary({ verdict: "watertight" });
    const after = summary({ verdict: "not-watertight", boundaryEdgeCount: 3 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("verification-failed");
  });

  it("reports verification-failed if the shell count changed (shell preservation violated)", () => {
    const before = summary({ shellCount: 2 });
    const after = summary({ shellCount: 1 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("verification-failed");
  });

  it("reports verification-failed if non-manifold edges increased", () => {
    const before = summary({ nonManifoldEdgeCount: 0 });
    const after = summary({ nonManifoldEdgeCount: 2 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("verification-failed");
  });
});

describe("determineOutcome — partial / unchanged states", () => {
  it("reports partially-reduced when triangles were removed but the exact target wasn't reached", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 700 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "no-safe-collapses-remain",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 700,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("partially-reduced");
  });

  it("reports unchanged-no-safe-collapses when no triangles could be safely removed at all", () => {
    const before = summary({ triangleCount: 4 });
    const after = summary({ triangleCount: 4 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "no-safe-collapses-remain",
      requestedTargetTriangleCount: 1,
      achievedTriangleCount: 4,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("unchanged-no-safe-collapses");
  });
});

describe("determineOutcome — preset quality-policy thresholds", () => {
  it("never reports target-achieved when the surface-area threshold was exceeded, even though the triangle target was met and all other invariants hold", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
      thresholdCheck: { exceededSurfaceAreaThreshold: true, exceededVolumeThreshold: false, reason: "surface area changed by 40.00%, exceeding this preset's own 12% limit" },
    });
    expect(outcome).not.toBe("target-achieved");
    expect(outcome).not.toBe("reduced-safely");
    expect(outcome).toBe("verification-failed");
  });

  it("never reports target-achieved when the volume threshold was exceeded", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
      thresholdCheck: { exceededSurfaceAreaThreshold: false, exceededVolumeThreshold: true, reason: "volume changed by 20.00%, exceeding this preset's own 8% limit" },
    });
    expect(outcome).toBe("verification-failed");
  });

  it("still reports target-achieved when the threshold check passed cleanly", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
      thresholdCheck: { exceededSurfaceAreaThreshold: false, exceededVolumeThreshold: false, reason: null },
    });
    expect(outcome).toBe("target-achieved");
  });

  it("treats a missing thresholdCheck as passing (backward-compatible default, never a false failure)", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 400 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "target-reached",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 400,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("target-achieved");
  });
});

describe("determineOutcome — cancellation", () => {
  it("reports cancelled when the stop reason is cancellation, regardless of partial progress", () => {
    const before = summary({ triangleCount: 1000 });
    const after = summary({ triangleCount: 800 });
    const outcome = determineOutcome({
      before,
      after,
      stopReason: "cancelled",
      requestedTargetTriangleCount: 400,
      achievedTriangleCount: 800,
      deviationCompleted: true,
      unresolvedProblems: [],
    });
    expect(outcome).toBe("cancelled");
  });
});
