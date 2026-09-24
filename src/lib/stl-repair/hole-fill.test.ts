import { describe, expect, it } from "vitest";
import { fillHoles } from "./hole-fill";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { closedTetrahedron, openCubeMissingFace, outwardClosedCube, singleBoundaryLoop } from "../stl-diagnostics/test-fixtures";

const LIMITS = { maxLoopVertexCount: 500, maxLoopPerimeterRatio: 10, maxLoopAreaRatio: 10, maxPatchTrianglesPerLoop: 500, maxHolesFilled: 100 };

function tri(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  out.push(...a, ...b, ...c);
}

/** The outward cube minus a single triangle from its +z face (not both), leaving a 3-edge triangular boundary loop. */
function cubeMissingOneTriangle(): Float32Array {
  const full = outwardClosedCube();
  // outwardClosedCube emits +z face as 2 triangles right after -z's 2 (see cubeFaces: quad order -z,+z,-y,+y,-x,+x).
  // Each quad = 2 triangles * 9 floats = 18 floats; +z quad starts right after -z's 18.
  const out: number[] = [];
  for (let t = 0; t < full.length / 9; t++) {
    if (t === 2) continue; // drop the first of the +z quad's 2 triangles
    out.push(...full.subarray(t * 9, t * 9 + 9));
  }
  return Float32Array.from(out);
}

async function diagnose(positions: Float32Array) {
  return analyzeSTLDiagnostics(positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
}

describe("fillHoles — end-to-end", () => {
  it("a closed mesh with no boundary has zero eligible loops and is unchanged", async () => {
    const result = await fillHoles(outwardClosedCube(), LIMITS);
    expect(result.eligibleLoopCount).toBe(0);
    expect(result.filledLoopCount).toBe(0);
    expect(result.trianglesAdded).toBe(0);
  });

  it("fills a simple planar quad hole (4-edge boundary loop) and the result is watertight", async () => {
    const result = await fillHoles(openCubeMissingFace(), LIMITS);
    expect(result.eligibleLoopCount).toBe(1);
    expect(result.filledLoopCount).toBe(1);
    expect(result.trianglesAdded).toBeGreaterThan(0);
    const after = await diagnose(result.positions);
    expect(after.boundaryEdgeCount).toBe(0);
    expect(after.verdict).toBe("watertight");
  });

  it("fills a simple planar triangular hole (3-edge boundary loop)", async () => {
    const before = await diagnose(cubeMissingOneTriangle());
    expect(before.boundaryEdgeCount).toBe(3);
    const result = await fillHoles(cubeMissingOneTriangle(), LIMITS);
    expect(result.filledLoopCount).toBe(1);
    const after = await diagnose(result.positions);
    expect(after.boundaryEdgeCount).toBe(0);
    expect(after.verdict).toBe("watertight");
  });

  it("fills a flat quad's own 4-edge boundary loop, doubling it into a closed 2-sided shell", async () => {
    const result = await fillHoles(singleBoundaryLoop(), LIMITS);
    expect(result.filledLoopCount).toBe(1);
    const after = await diagnose(result.positions);
    expect(after.boundaryEdgeCount).toBe(0);
  });

  it("orients the patch so the repaired region's winding is consistent with its neighbors (no new winding conflicts)", async () => {
    const result = await fillHoles(openCubeMissingFace(), LIMITS);
    const after = await diagnose(result.positions);
    expect(after.windingConflictEdgeCount).toBe(0);
  });

  it("skips a loop exceeding the vertex-count ceiling and reports why", async () => {
    const result = await fillHoles(openCubeMissingFace(), { ...LIMITS, maxLoopVertexCount: 3 });
    expect(result.filledLoopCount).toBe(0);
    expect(result.skips.some((s) => s.reason === "vertex-count-limit")).toBe(true);
  });

  it("skips a loop exceeding the perimeter ceiling and reports why", async () => {
    const result = await fillHoles(openCubeMissingFace(), { ...LIMITS, maxLoopPerimeterRatio: 1e-6 });
    expect(result.filledLoopCount).toBe(0);
    expect(result.skips.some((s) => s.reason === "perimeter-limit")).toBe(true);
  });

  it("skips a loop exceeding the area ceiling and reports why", async () => {
    const result = await fillHoles(openCubeMissingFace(), { ...LIMITS, maxLoopAreaRatio: 1e-9 });
    expect(result.filledLoopCount).toBe(0);
    expect(result.skips.some((s) => s.reason === "area-limit")).toBe(true);
  });

  it("respects the hole-count ceiling, skipping remaining eligible loops beyond it", async () => {
    // Two separate cube-missing-face holes stitched into one buffer (fully disjoint, far apart).
    const a = openCubeMissingFace();
    const b = openCubeMissingFace();
    const shifted = new Float32Array(a.length + b.length);
    shifted.set(a, 0);
    for (let i = 0; i < b.length; i += 3) {
      shifted[a.length + i] = b[i] + 10;
      shifted[a.length + i + 1] = b[i + 1] + 10;
      shifted[a.length + i + 2] = b[i + 2] + 10;
    }
    const result = await fillHoles(shifted, { ...LIMITS, maxHolesFilled: 1 });
    expect(result.eligibleLoopCount).toBe(2);
    expect(result.filledLoopCount).toBe(1);
    expect(result.skips.some((s) => s.reason === "hole-count-limit")).toBe(true);
  });

  it("does not treat a non-simple/branched boundary component as fillable", async () => {
    // three-triangles-sharing-one-edge has a branched boundary — see mesh/boundary-components.test.ts.
    const branched = Float32Array.from((() => {
      const out: number[] = [];
      const a: [number, number, number] = [0, 0, 0];
      const b: [number, number, number] = [0, 0, 1];
      const c: [number, number, number] = [1, 0, 0];
      const d: [number, number, number] = [0, 1, 0];
      const e: [number, number, number] = [-1, -1, 0];
      tri(out, a, b, c);
      tri(out, a, b, d);
      tri(out, a, b, e);
      return out;
    })());
    const result = await fillHoles(branched, LIMITS);
    expect(result.filledLoopCount).toBe(0);
    expect(result.skips.some((s) => s.reason === "not-a-closed-loop")).toBe(true);
  });

  it("never mutates the input buffer", async () => {
    const input = openCubeMissingFace();
    const copy = input.slice();
    await fillHoles(input, LIMITS);
    expect(input).toEqual(copy);
  });

  it("a tetrahedron (already closed) has zero eligible loops", async () => {
    const result = await fillHoles(closedTetrahedron(), LIMITS);
    expect(result.eligibleLoopCount).toBe(0);
  });
});

describe("fillHoles — narrow-phase triangulation cases via direct polygon coordinates", () => {
  // These reuse mesh/triangulate.ts's own proven test coordinates
  // directly, exercising the exact same triangulatePolygon() call
  // fillHoles() makes, without needing to hand-construct a full 3D mesh
  // whose boundary happens to be this exact shape (see this module's own
  // doc comment on why hole-fill reuses triangulate.ts unchanged).
  it("concave L-shaped hexagon triangulates via ear-clipping (reused directly from mesh/triangulate.test.ts)", async () => {
    const { triangulatePolygon } = await import("../mesh/triangulate");
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ];
    const result = triangulatePolygon(vertices, 10_000);
    expect(result.triangles).toHaveLength(4);
  });

  it("rejects a self-intersecting boundary loop rather than guessing a triangulation", async () => {
    const { triangulatePolygon } = await import("../mesh/triangulate");
    const { PolygonSelfIntersectingError } = await import("../mesh/errors");
    // A bowtie: edges (0,1)-(2,3) cross.
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [2, 2, 0],
      [2, 0, 0],
      [0, 2, 0],
    ];
    expect(() => triangulatePolygon(vertices, 10_000)).toThrow(PolygonSelfIntersectingError);
  });

  it("rejects a loop that deviates too far from planar", async () => {
    const { triangulatePolygon } = await import("../mesh/triangulate");
    const { PolygonNonPlanarError } = await import("../mesh/errors");
    const vertices: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 5],
      [0, 10, 0],
    ];
    expect(() => triangulatePolygon(vertices, 10_000)).toThrow(PolygonNonPlanarError);
  });
});
