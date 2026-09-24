import { describe, expect, it } from "vitest";
import { isSafeError } from "../errors";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { safePreset, standardPreset } from "../stl-repair/types";
import { openCubeMissingFace, outwardClosedCube, threeTrianglesSharingOneEdge } from "../stl-diagnostics/test-fixtures";
import { planRepairFile } from "./repair-plan";

function stlFile(positions: Float32Array, name: string): File {
  return new File([serializeBinarySTL({ positions })], name, { type: "model/stl" });
}

describe("planRepairFile — real diagnostics + planning pipeline, never mutates", () => {
  it("reports detected issues and a planned hole-fill operation for an open mesh", async () => {
    const summary = await planRepairFile(stlFile(openCubeMissingFace(), "open.stl"), safePreset());
    expect(summary.detectedIssues.length).toBeGreaterThan(0);
    expect(summary.plannedOperations).toContain("fill-eligible-holes");
    expect(summary.eligibility).not.toBe("already-valid");
  });

  it("reports no planned operations and already-valid eligibility for a watertight mesh", async () => {
    const summary = await planRepairFile(stlFile(outwardClosedCube(), "valid.stl"), safePreset());
    expect(summary.plannedOperations).toEqual([]);
    expect(summary.eligibility).toBe("already-valid");
  });

  it("exposes the exact selected preset and weld tolerance", async () => {
    const settings = standardPreset(10);
    const summary = await planRepairFile(stlFile(outwardClosedCube(), "valid.stl"), settings);
    expect(summary.preset).toBe("standard");
    expect(summary.weldTolerance).toBe(settings.weld.toleranceAbs);
  });

  it("weld tolerance is null when welding isn't enabled (Safe preset)", async () => {
    const summary = await planRepairFile(stlFile(outwardClosedCube(), "valid.stl"), safePreset());
    expect(summary.weldTolerance).toBeNull();
  });

  it("flags unresolved non-manifold topology as a distinct eligibility class, not 'eligible'", async () => {
    const summary = await planRepairFile(stlFile(threeTrianglesSharingOneEdge(), "nonmanifold.stl"), safePreset());
    expect(summary.eligibility).toBe("unresolved-risk");
  });

  it("lists skipped operations too, with their reason implicitly available via the plan", async () => {
    const summary = await planRepairFile(stlFile(outwardClosedCube(), "valid.stl"), safePreset());
    expect(summary.skippedOperations.length).toBeGreaterThan(0);
  });

  it("never mutates — the input file's bytes are untouched by planning", async () => {
    const file = stlFile(openCubeMissingFace(), "open.stl");
    const before = await file.arrayBuffer();
    await planRepairFile(file, safePreset());
    const after = await file.arrayBuffer();
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });

  it("rejects with an already-safe error (never a raw parser exception) when the file isn't a valid STL", async () => {
    const invalidFile = new File([new Uint8Array([1, 2, 3, 4])], "not-an-stl.stl", { type: "model/stl" });
    let caught: unknown = null;
    try {
      await planRepairFile(invalidFile, safePreset());
    } catch (err) {
      caught = err;
    }
    expect(isSafeError(caught)).toBe(true);
  });
});
