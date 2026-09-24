import { describe, expect, it } from "vitest";
import { planRepair } from "./plan";
import { safePreset, standardPreset } from "./types";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { openCubeMissingFace, outwardClosedCube } from "../stl-diagnostics/test-fixtures";

describe("planRepair", () => {
  it("never mutates anything — a plan for a clean mesh has no operations that will run", async () => {
    const diagnostics = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, safePreset());
    expect(plan.steps.every((s) => !s.willRun)).toBe(true);
  });

  it("plans hole-filling for a mesh with a closed boundary loop under Safe preset", async () => {
    const diagnostics = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, safePreset());
    const fillStep = plan.steps.find((s) => s.operation === "fill-eligible-holes");
    expect(fillStep?.willRun).toBe(true);
  });

  it("Safe preset never plans welding, even when it might help", async () => {
    const diagnostics = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, safePreset());
    const weldStep = plan.steps.find((s) => s.operation === "weld-vertices")!;
    expect(weldStep.willRun).toBe(false);
  });

  it("Standard preset plans welding when enabled", async () => {
    const diagnostics = await analyzeSTLDiagnostics(outwardClosedCube(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, standardPreset(2));
    const weldStep = plan.steps.find((s) => s.operation === "weld-vertices")!;
    expect(weldStep.willRun).toBe(true);
  });

  it("includes the original diagnostics summary", async () => {
    const diagnostics = await analyzeSTLDiagnostics(openCubeMissingFace(), DEFAULT_STL_DIAGNOSTICS_LIMITS);
    const plan = planRepair(diagnostics, safePreset());
    expect(plan.originalSummary.boundaryEdgeCount).toBe(4);
    expect(plan.originalSummary.verdict).toBe("not-watertight");
  });
});
