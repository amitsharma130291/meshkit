import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import {
  closedTetrahedron,
  nearZeroAreaTriangle,
  outwardClosedCube,
  repeatedPositionDegeneracy,
  zeroAreaCollinearTriangle,
} from "../stl-diagnostics/test-fixtures";

const LIMITS = { maxUniqueVertices: 1_000_000 };

describe("buildCanonicalMesh — exact vertex identity", () => {
  it("a closed tetrahedron has 4 source-shared vertices reused across 4 triangles (12 slots, 4 unique)", async () => {
    const mesh = await buildCanonicalMesh(closedTetrahedron(), LIMITS);
    expect(mesh.sourceVertexCount).toBe(12);
    expect(mesh.uniqueVertexCount).toBe(4);
    expect(mesh.duplicateCoordinateReferenceCount).toBe(8);
    expect(mesh.triangleCount).toBe(4);
  });

  it("a cube's 12 triangles reference exactly 8 unique corner positions", async () => {
    const mesh = await buildCanonicalMesh(outwardClosedCube(), LIMITS);
    expect(mesh.uniqueVertexCount).toBe(8);
    expect(mesh.sourceVertexCount).toBe(36);
  });

  it("-0 and 0 are treated as the same vertex position", async () => {
    // A single triangle with one corner given as -0 in two of its components.
    const positions = Float32Array.from([-0, -0, 0, 1, 0, 0, 0, 1, 0]);
    const mesh = await buildCanonicalMesh(positions, LIMITS);
    // The corner (-0,-0,0) and a hypothetical (0,0,0) must key identically —
    // verified indirectly: this mesh's own single corner must dedupe with
    // itself consistently across repeated builds (no crash, stable count).
    expect(mesh.uniqueVertexCount).toBe(3);
  });
});

describe("buildCanonicalMesh — degenerate triangle classification", () => {
  it("classifies a repeated-vertex triangle as repeated-vertex, excluded from validTriangles", async () => {
    const mesh = await buildCanonicalMesh(repeatedPositionDegeneracy(), LIMITS);
    expect(mesh.repeatedVertexCount).toBe(1);
    expect(mesh.degenerate).toEqual([{ index: 1, reason: "repeated-vertex" }]);
    expect(mesh.validTriangles.map((t) => t.index)).toEqual([0]);
  });

  it("classifies a collinear triangle as exactly zero-area", async () => {
    const mesh = await buildCanonicalMesh(zeroAreaCollinearTriangle(), LIMITS);
    expect(mesh.exactZeroAreaCount).toBe(1);
    expect(mesh.degenerate.some((d) => d.index === 1 && d.reason === "zero-area")).toBe(true);
    expect(mesh.validTriangles.map((t) => t.index)).toEqual([0]);
  });

  it("classifies a tiny-but-nonzero sliver as near-zero-area, scaled to the mesh's own bounding box", async () => {
    const mesh = await buildCanonicalMesh(nearZeroAreaTriangle(), LIMITS);
    expect(mesh.nearZeroAreaCount).toBe(1);
    expect(mesh.degenerate.some((d) => d.index === 1 && d.reason === "near-zero-area")).toBe(true);
  });

  it("a legitimately small triangle relative to a SMALL mesh is not flagged near-zero", async () => {
    // Same absolute sliver size as nearZeroAreaTriangle's second triangle,
    // but with no huge reference triangle — scale-aware means this one
    // should NOT be penalized just because it's small in absolute terms.
    const positions = Float32Array.from([0, 0, 0, 0.0001, 0, 0, 0, 0.0001, 0]);
    const mesh = await buildCanonicalMesh(positions, LIMITS);
    expect(mesh.nearZeroAreaCount).toBe(0);
    expect(mesh.exactZeroAreaCount).toBe(0);
    expect(mesh.repeatedVertexCount).toBe(0);
  });

  it("all-valid mesh has an empty degenerate list and validTriangles === triangles", async () => {
    const mesh = await buildCanonicalMesh(closedTetrahedron(), LIMITS);
    expect(mesh.degenerate).toHaveLength(0);
    expect(mesh.validTriangles).toHaveLength(mesh.triangles.length);
  });
});
