import { describe, expect, it } from "vitest";
import { computeSurfaceArea, compareSurfaceArea, compareVolume, checkThresholds } from "./volume-surface";
import {
  closedTetrahedron,
  outwardClosedCube,
  inwardClosedCube,
  disconnectedShells,
  openCubeMissingFace,
  translatedClosedShell,
  largeCancellationFixture,
} from "../stl-diagnostics/test-fixtures";
import { CancellationRequested } from "../cancellation";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";

async function analyzeFixture(positions: Float32Array) {
  return analyzeSTLDiagnostics(positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
}

/**
 * A closed tetrahedron with one face's winding flipped relative to
 * `closedTetrahedron()` — same edges/incidence (still closed, and per a
 * real discovery this fixture led to, `mesh/orientation.ts`'s own BFS
 * parity propagation ALWAYS finds a valid global resolution for any
 * closed, manifold, topologically-orientable shell, however its raw
 * per-triangle winding is stored — `consistentlyOrientable` reflects the
 * shell's TOPOLOGY, not its input winding. This fixture is kept as the
 * "raw winding conflicts don't block volume eligibility" test case
 * below, not as an "indeterminate" case (see that test's own comment).
 */
function closedRawWindingConflictTetrahedron(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0, 1, 0];
  const d: [number, number, number] = [0, 0, 1];
  const out: number[] = [];
  const tri = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => out.push(...p, ...q, ...r);
  tri(a, c, b);
  tri(a, d, b); // flipped relative to closedTetrahedron()'s own `tri(a, b, d)` — creates 3 raw winding-conflict edges
  tri(b, c, d);
  tri(c, a, d);
  return Float32Array.from(out);
}

/**
 * A near-degenerate (flattened, not uniformly scaled — uniform scaling
 * preserves the volume/diagonal³ ratio and so never actually triggers
 * "near zero" relative to the shell's own scale, a real mistake this
 * fixture's own first version made) tetrahedron whose apex sits a tiny
 * fraction of a unit off the base plane — its volume falls below
 * `mesh/orientation.ts`'s own scale-relative near-zero-volume threshold.
 */
function nearZeroVolumeShell(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0, 1, 0];
  const d: [number, number, number] = [0.3, 0.3, 1e-9];
  const out: number[] = [];
  const tri = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => out.push(...p, ...q, ...r);
  tri(a, c, b);
  tri(a, b, d);
  tri(b, c, d);
  tri(c, a, d);
  return Float32Array.from(out);
}

describe("computeSurfaceArea", () => {
  it("computes the exact known surface area of a unit cube (6 faces of 1x1)", async () => {
    const area = await computeSurfaceArea(outwardClosedCube());
    expect(area).toBeCloseTo(6, 5);
  });

  it("computes a positive, non-zero area for a tetrahedron", async () => {
    const area = await computeSurfaceArea(closedTetrahedron());
    expect(area).toBeGreaterThan(0);
  });

  it("is deterministic across repeated calls on the same input", async () => {
    const positions = outwardClosedCube();
    const a = await computeSurfaceArea(positions);
    const b = await computeSurfaceArea(positions);
    expect(a).toBe(b);
  });

  it("returns exactly zero for an empty (no-triangle) input", async () => {
    const area = await computeSurfaceArea(new Float32Array(0));
    expect(area).toBe(0);
  });

  it("rejects non-finite coordinates", async () => {
    const bad = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, NaN]);
    await expect(computeSurfaceArea(bad)).rejects.toThrow();
  });

  it("supports cancellation during a large calculation", async () => {
    const positions = largeCancellationFixture();
    await expect(computeSurfaceArea(positions, { isCancelled: () => true })).rejects.toThrow(CancellationRequested);
  });
});

describe("compareSurfaceArea", () => {
  it("reports before, after, absolute change and percentage change", () => {
    const result = compareSurfaceArea(10, 8);
    expect(result.surfaceAreaBefore).toBe(10);
    expect(result.surfaceAreaAfter).toBe(8);
    expect(result.surfaceAreaChange).toBeCloseTo(-2, 10);
    expect(result.surfaceAreaChangePercent).toBeCloseTo(-20, 10);
  });

  it("returns a null percentage when the original area is exactly zero (division-by-zero guard)", () => {
    const result = compareSurfaceArea(0, 5);
    expect(result.surfaceAreaChangePercent).toBeNull();
  });

  it("is deterministic", () => {
    const a = compareSurfaceArea(12.5, 9.75);
    const b = compareSurfaceArea(12.5, 9.75);
    expect(a).toEqual(b);
  });
});

describe("classifyMeshVolume + compareVolume — closed-shell volume eligibility", () => {
  it("reports 'completed' for an outward closed tetrahedron", async () => {
    const report = await analyzeFixture(closedTetrahedron());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("completed");
    expect(result.volumeBefore).toBeGreaterThan(0);
  });

  it("reports 'completed' for an outward closed cube, with the known unit-cube volume", async () => {
    const report = await analyzeFixture(outwardClosedCube());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("completed");
    expect(result.volumeBefore).toBeCloseTo(1, 5);
  });

  it("reports the identical volume for a translated copy of the same closed mesh (translation-stable)", async () => {
    const reportA = await analyzeFixture(outwardClosedCube());
    const reportB = await analyzeFixture(translatedClosedShell());
    const resultA = compareVolume(reportA, reportA);
    const resultB = compareVolume(reportB, reportB);
    expect(resultB.volumeStatus).toBe("completed");
    expect(resultB.volumeBefore).toBeCloseTo(resultA.volumeBefore!, 5);
  });

  it("reports 'completed' for an inward closed cube (orientation doesn't block eligibility, only sign)", async () => {
    const report = await analyzeFixture(inwardClosedCube());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("completed");
    expect(result.volumeBefore).toBeGreaterThan(0); // magnitude, never a signed/negative number
  });

  it("reports 'completed' with the SUMMED magnitude for multiple closed shells", async () => {
    const report = await analyzeFixture(disconnectedShells());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("completed");
    const single = compareVolume(await analyzeFixture(closedTetrahedron()), await analyzeFixture(closedTetrahedron()));
    expect(result.volumeBefore).toBeCloseTo(single.volumeBefore! * 2, 4);
  });

  it("reports 'not-applicable' for an open mesh, never a false zero", async () => {
    const report = await analyzeFixture(openCubeMissingFace());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("not-applicable");
    expect(result.volumeBefore).toBeNull();
    expect(result.volumeReason).toBeTruthy();
  });

  it("still reports 'completed' for a closed mesh with raw per-triangle winding conflicts, since Phase 5's own BFS resolution already found a valid global orientation for it (a real discovery — see the fixture's own doc comment)", async () => {
    const report = await analyzeFixture(closedRawWindingConflictTetrahedron());
    expect(report.windingConflictEdgeCount).toBeGreaterThan(0); // sanity: the raw conflict really is present
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("completed");
    expect(result.volumeBefore).toBeGreaterThan(0);
  });

  it("reports 'indeterminate' for a near-zero-volume shell (reuses Phase 5's own near-zero-volume threshold, never a noise-dominated sign)", async () => {
    const report = await analyzeFixture(nearZeroVolumeShell());
    const result = compareVolume(report, report);
    expect(result.volumeStatus).toBe("indeterminate");
  });

  it("is deterministic across repeated calls on the same report", async () => {
    const report = await analyzeFixture(outwardClosedCube());
    const a = compareVolume(report, report);
    const b = compareVolume(report, report);
    expect(a).toEqual(b);
  });
});

describe("checkThresholds", () => {
  const preset = { maxSurfaceAreaChangePercent: 10, maxVolumeChangePercent: 10 };

  it("passes when both changes are within the preset's own thresholds", () => {
    const metrics = {
      surfaceAreaBefore: 100,
      surfaceAreaAfter: 95,
      surfaceAreaChange: -5,
      surfaceAreaChangePercent: -5,
      volumeBefore: 10,
      volumeAfter: 9.5,
      volumeChange: -0.5,
      volumeChangePercent: -5,
      volumeStatus: "completed" as const,
    };
    const result = checkThresholds(metrics, preset);
    expect(result.exceededSurfaceAreaThreshold).toBe(false);
    expect(result.exceededVolumeThreshold).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("fails when the surface-area change exceeds the preset threshold", () => {
    const metrics = {
      surfaceAreaBefore: 100,
      surfaceAreaAfter: 80,
      surfaceAreaChange: -20,
      surfaceAreaChangePercent: -20,
      volumeBefore: null,
      volumeAfter: null,
      volumeChange: null,
      volumeChangePercent: null,
      volumeStatus: "not-applicable" as const,
    };
    const result = checkThresholds(metrics, preset);
    expect(result.exceededSurfaceAreaThreshold).toBe(true);
    expect(result.reason).toContain("surface area");
  });

  it("fails when the volume change exceeds the preset threshold", () => {
    const metrics = {
      surfaceAreaBefore: 100,
      surfaceAreaAfter: 98,
      surfaceAreaChange: -2,
      surfaceAreaChangePercent: -2,
      volumeBefore: 10,
      volumeAfter: 8,
      volumeChange: -2,
      volumeChangePercent: -20,
      volumeStatus: "completed" as const,
    };
    const result = checkThresholds(metrics, preset);
    expect(result.exceededVolumeThreshold).toBe(true);
    expect(result.reason).toContain("volume");
  });

  it("never enforces the volume threshold when volume isn't measurable (no false failure on open/indeterminate geometry)", () => {
    const metrics = {
      surfaceAreaBefore: 100,
      surfaceAreaAfter: 98,
      surfaceAreaChange: -2,
      surfaceAreaChangePercent: -2,
      volumeBefore: null,
      volumeAfter: null,
      volumeChange: null,
      volumeChangePercent: null,
      volumeStatus: "not-applicable" as const,
    };
    const result = checkThresholds(metrics, preset);
    expect(result.exceededVolumeThreshold).toBe(false);
  });

  it("is deterministic", () => {
    const metrics = {
      surfaceAreaBefore: 100,
      surfaceAreaAfter: 80,
      surfaceAreaChange: -20,
      surfaceAreaChangePercent: -20,
      volumeBefore: null,
      volumeAfter: null,
      volumeChange: null,
      volumeChangePercent: null,
      volumeStatus: "not-applicable" as const,
    };
    expect(checkThresholds(metrics, preset)).toEqual(checkThresholds(metrics, preset));
  });
});
