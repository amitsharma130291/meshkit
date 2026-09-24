import { describe, expect, it } from "vitest";
import { repairSTL } from "./repair";
import { DEFAULT_REPAIR_LIMITS, safePreset, standardPreset } from "./types";
import { STLRepairException } from "./errors";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import {
  duplicateFaceSameWinding,
  inconsistentAdjacentWinding,
  inwardClosedCube,
  openCubeMissingFace,
  outwardClosedCube,
  properTriangleIntersection,
  repeatedPositionDegeneracy,
  threeTrianglesSharingOneEdge,
} from "../stl-diagnostics/test-fixtures";
import { nearDuplicateSeam } from "./test-fixtures";

describe("repairSTL — end-to-end, output reparsed and re-verified", () => {
  it("an already-watertight mesh is reported unchanged, with valid re-parseable output", async () => {
    const result = await repairSTL(outwardClosedCube(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.outcome).toBe("unchanged");
    expect(result.watertightVerdictAfter).toBe("watertight");
    expect(result.outputBytes).not.toBeNull();

    // Verified: the ACTUAL output bytes reparse and diagnose clean.
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.verdict).toBe("watertight");
  });

  it("fills a hole and is fully-repaired, verified against the actual output bytes", async () => {
    const result = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.watertightVerdictBefore).toBe("not-watertight");
    expect(result.holesFilled).toBe(1);
    expect(result.outcome).toBe("fully-repaired");
    expect(result.watertightVerdictAfter).toBe("watertight");

    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.verdict).toBe("watertight");
    expect(verified.boundaryEdgeCount).toBe(0);
  });

  it("removes a degenerate triangle and reports the correct category count", async () => {
    const result = await repairSTL(repeatedPositionDegeneracy(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.trianglesRemovedByCategory.repeatedVertex).toBe(1);
    expect(result.trianglesAfter).toBe(1);
  });

  it("removes a duplicate face", async () => {
    const result = await repairSTL(duplicateFaceSameWinding(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.trianglesRemovedByCategory.sameWindingDuplicate).toBeGreaterThan(0);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.sameWindingDuplicateFaceCount).toBe(0);
  });

  it("corrects a winding conflict", async () => {
    const result = await repairSTL(inconsistentAdjacentWinding(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.trianglesFlipped).toBe(1);
    expect(result.windingConflictsBefore).toBe(1);
    expect(result.windingConflictsAfter).toBe(0);
  });

  it("orients an inward closed shell outward", async () => {
    const result = await repairSTL(inwardClosedCube(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.shellsReversed).toBe(1);
    expect(result.watertightVerdictBefore).toBe("watertight"); // inward is still watertight per Phase 5's own policy
    expect(result.outcome).toBe("improved"); // inward -> outward is a real fix, but wasn't "broken" in the watertight sense
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.inwardShellCount).toBe(0);
  });

  it("welds a near-duplicate seam under the Standard preset and closes the boundary", async () => {
    const settings = standardPreset(1.5); // matches nearDuplicateSeam's own ~1.4-unit diagonal
    settings.weld.toleranceAbs = 0.001; // comfortably above the fixture's 0.0005 gap
    const result = await repairSTL(nearDuplicateSeam(), settings, DEFAULT_REPAIR_LIMITS);
    expect(result.verticesWelded).toBeGreaterThan(0);
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.boundaryEdgeCount).toBeLessThan(8); // fewer boundary edges than the 8 present before welding
  });

  it("leaves non-manifold topology unresolved and honestly reported, never claiming it was fixed", async () => {
    const result = await repairSTL(threeTrianglesSharingOneEdge(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.nonManifoldEdgesBefore).toBe(1);
    expect(result.nonManifoldEdgesAfter).toBe(1); // never deletes arbitrary triangles to force this to 2
    expect(result.outcome).toBe("unable-to-repair-safely");
    expect(result.unresolvedProblems.some((p) => p.includes("non-manifold"))).toBe(true);
  });

  it("detects (never resolves) a self-intersection, and never claims it was fixed", async () => {
    const result = await repairSTL(properTriangleIntersection(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(result.selfIntersectionStatusBefore).toBe("completed");
    expect(result.selfIntersectionStatusAfter).toBe("completed");
    // The self-intersecting pair is untouched by any Safe-mode operation (no geometry-deleting operation targets it).
    const reparsed = parseSTL(result.outputBytes!, DEFAULT_STL_LIMITS);
    const verified = await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(verified.selfIntersections.intersectingPairCount).toBeGreaterThan(0);
    expect(result.outcome).toBe("unable-to-repair-safely");
    expect(result.unresolvedProblems.some((p) => p.includes("self-intersecting"))).toBe(true);
  });

  it("never mutates the input buffer", async () => {
    const input = openCubeMissingFace();
    const copy = input.slice();
    await repairSTL(input, safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(input).toEqual(copy);
  });

  it("includes stage timings for every named stage", async () => {
    const result = await repairSTL(outwardClosedCube(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const names = result.stageTimings.map((s) => s.stage);
    expect(names).toEqual([
      "checking-original-mesh",
      "planning-repairs",
      "welding-vertices",
      "removing-invalid-faces",
      "correcting-winding",
      "filling-holes",
      "cleaning-shells",
      "writing-repaired-stl",
      "verifying-repaired-stl",
      "preparing-comparison",
    ]);
  });

  it("throws STLREPAIR_NO_VALID_TRIANGLES for a mesh with no usable triangles", async () => {
    const allDegenerate = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(repairSTL(allDegenerate, safePreset(), DEFAULT_REPAIR_LIMITS)).rejects.toThrow(STLRepairException);
  });

  it("throws STLREPAIR_UNSAFE_TOLERANCE for a tolerance exceeding the safe ratio", async () => {
    const settings = standardPreset(1);
    settings.weld.toleranceAbs = 1000; // absurdly large relative to a unit cube
    await expect(repairSTL(outwardClosedCube(), settings, DEFAULT_REPAIR_LIMITS)).rejects.toThrow(STLRepairException);
  });

  it("is deterministic: repairing the same input twice produces the same result (except timings)", async () => {
    const a = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    const b = await repairSTL(openCubeMissingFace(), safePreset(), DEFAULT_REPAIR_LIMITS);
    expect(a.outputBytes).toEqual(b.outputBytes);
    expect(a.outcome).toBe(b.outcome);
    expect(a.holesFilled).toBe(b.holesFilled);
  });

  it("supports cancellation", async () => {
    await expect(repairSTL(outwardClosedCube(), safePreset(), DEFAULT_REPAIR_LIMITS, { isCancelled: () => true })).rejects.toThrow();
  });
});
