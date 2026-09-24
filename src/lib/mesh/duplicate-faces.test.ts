import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "./canonical-vertices";
import { analyzeDuplicateFaces } from "./duplicate-faces";
import { closedTetrahedron, duplicateFaceReverseWinding, duplicateFaceSameWinding, outwardClosedCube } from "../stl-diagnostics/test-fixtures";

const VERTEX_LIMITS = { maxUniqueVertices: 1_000_000 };
const DUP_LIMITS = { maxGroups: 1000, maxTriangleIndicesPerGroup: 100 };

describe("analyzeDuplicateFaces", () => {
  it("a mesh with no duplicated triangles reports zero groups", async () => {
    const mesh = await buildCanonicalMesh(outwardClosedCube(), VERTEX_LIMITS);
    const result = analyzeDuplicateFaces(mesh.validTriangles, DUP_LIMITS);
    expect(result.groups).toHaveLength(0);
    expect(result.sameWindingDuplicateFaceCount).toBe(0);
    expect(result.reverseWindingDuplicateFaceCount).toBe(0);
  });

  it("an exact same-winding duplicate face is reported as a same-winding duplicate", async () => {
    const mesh = await buildCanonicalMesh(duplicateFaceSameWinding(), VERTEX_LIMITS);
    const result = analyzeDuplicateFaces(mesh.validTriangles, DUP_LIMITS);
    expect(result.sameWindingDuplicateFaceCount).toBe(1);
    expect(result.reverseWindingDuplicateFaceCount).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].sameWindingTriangleIndices).toHaveLength(2);
  });

  it("a reverse-winding duplicate face is reported as a reverse-winding duplicate, not same-winding", async () => {
    const mesh = await buildCanonicalMesh(duplicateFaceReverseWinding(), VERTEX_LIMITS);
    const result = analyzeDuplicateFaces(mesh.validTriangles, DUP_LIMITS);
    expect(result.sameWindingDuplicateFaceCount).toBe(0);
    expect(result.reverseWindingDuplicateFaceCount).toBe(1);
    expect(result.groups[0].sameWindingTriangleIndices).toHaveLength(1);
    expect(result.groups[0].reverseWindingTriangleIndices).toHaveLength(1);
  });

  it("two triangles merely sharing an edge are never reported as a duplicate group", async () => {
    const mesh = await buildCanonicalMesh(closedTetrahedron(), VERTEX_LIMITS);
    const result = analyzeDuplicateFaces(mesh.validTriangles, DUP_LIMITS);
    expect(result.groups).toHaveLength(0);
  });
});
