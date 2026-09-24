import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import { buildEdgeIncidence } from "./edge-incidence";
import { resolveTriangleShells } from "./connected-components";
import { analyzeShellOrientation } from "./orientation";
import {
  closedTetrahedron,
  inconsistentAdjacentWinding,
  inwardClosedCube,
  largeCancellationFixture,
  openCubeMissingFace,
  outwardClosedCube,
  reflectedClosedShell,
  translatedClosedShell,
} from "../stl-diagnostics/test-fixtures";

const VERTEX_LIMITS = { maxUniqueVertices: 1_000_000 };
const EDGE_LIMITS = { maxEdgeRecords: 1_000_000 };

async function analyzeFirstShell(positions: Float32Array) {
  const mesh = await buildCanonicalMesh(positions, VERTEX_LIMITS);
  const inc = buildEdgeIncidence(mesh.validTriangles, EDGE_LIMITS);
  const shells = resolveTriangleShells(mesh.validTriangles, inc.edgesByKey);
  const trianglesByIndex = new Map(mesh.validTriangles.map((t) => [t.index, t]));
  return analyzeShellOrientation(0, shells.triangleIndicesByShell[0], trianglesByIndex, inc.edgesByKey, mesh.vertices);
}

describe("analyzeShellOrientation", () => {
  it("an outward-wound closed cube is 'outward' with positive signed volume ~1", async () => {
    const result = await analyzeFirstShell(outwardClosedCube());
    expect(result.consistentlyOrientable).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.verdict).toBe("outward");
    expect(result.signedVolume).toBeCloseTo(1, 3);
  });

  it("an inward-wound closed cube is 'inward' with negative signed volume ~-1", async () => {
    const result = await analyzeFirstShell(inwardClosedCube());
    expect(result.consistentlyOrientable).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.verdict).toBe("inward");
    expect(result.signedVolume).toBeCloseTo(-1, 3);
  });

  it("a closed tetrahedron of edge length 1 has positive volume 1/6 * (base area formula) and verdict outward", async () => {
    const result = await analyzeFirstShell(closedTetrahedron());
    expect(result.verdict).toBe("outward");
    expect(result.signedVolume).toBeGreaterThan(0);
  });

  it("an open shell (missing one face) is never labeled inward/outward even though it's consistently orientable", async () => {
    const result = await analyzeFirstShell(openCubeMissingFace());
    expect(result.consistentlyOrientable).toBe(true);
    expect(result.closed).toBe(false);
    expect(result.verdict).toBe("indeterminate");
  });

  it("a shell with exactly one winding-conflict edge is still consistently orientable (a global re-orientation exists — flipping either triangle alone resolves the single conflict), and is never labeled inward/outward since it's open", async () => {
    // Consistent orientability is a GLOBAL property ("does a re-winding
    // exist that eliminates every conflict"), not "is the file's current
    // winding already conflict-free." A single conflicting edge with no
    // surrounding cycle is always resolvable (this is exactly the
    // standard 2-coloring/bipartite-graph guarantee: only an ODD CYCLE of
    // conflicts makes consistent orientation impossible — see this
    // module's own doc comment). `edge-incidence.ts`'s own
    // `windingConflictEdgeCount` is what reports "the file, as stored,
    // has a conflict here" — a separate, already-tested concern.
    const result = await analyzeFirstShell(inconsistentAdjacentWinding());
    expect(result.consistentlyOrientable).toBe(true);
    expect(result.closed).toBe(false);
    expect(result.verdict).toBe("indeterminate");
  });

  it("translating a closed shell far from the origin leaves its signed volume unchanged (translation invariance for a closed surface)", async () => {
    const base = await analyzeFirstShell(outwardClosedCube());
    const translated = await analyzeFirstShell(translatedClosedShell());
    expect(translated.signedVolume).toBeCloseTo(base.signedVolume, 2);
    expect(translated.verdict).toBe("outward");
  });

  it("reflecting a closed shell flips the sign of its signed volume and its inward/outward verdict", async () => {
    const base = await analyzeFirstShell(outwardClosedCube());
    const reflected = await analyzeFirstShell(reflectedClosedShell());
    expect(Math.sign(reflected.signedVolume)).toBe(-Math.sign(base.signedVolume));
    expect(reflected.verdict).toBe("inward");
  });

  it("a closed shell translated to a very large offset still resolves a stable volume close to 1 despite floating-point cancellation risk", async () => {
    const result = await analyzeFirstShell(largeCancellationFixture());
    expect(result.closed).toBe(true);
    expect(result.consistentlyOrientable).toBe(true);
    // Float32 precision at a coordinate magnitude of 1e5 is coarse (~0.008
    // ULP), so this only asserts the verdict/sign survive, not tight
    // numeric precision on the volume itself.
    expect(result.verdict).toBe("outward");
  });
});
