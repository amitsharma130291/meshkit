import { describe, expect, it } from "vitest";
import { removeDegenerateTriangles, removeDuplicateFaces } from "./cleanup";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import {
  duplicateFaceReverseWinding,
  duplicateFaceSameWinding,
  nearZeroAreaTriangle,
  outwardClosedCube,
  repeatedPositionDegeneracy,
  zeroAreaCollinearTriangle,
} from "../stl-diagnostics/test-fixtures";

describe("removeDegenerateTriangles", () => {
  it("removes a repeated-vertex triangle when removeExact is true", async () => {
    const result = await removeDegenerateTriangles(repeatedPositionDegeneracy(), { removeExact: true, removeNearZero: false });
    expect(result.repeatedVertexRemoved).toBe(1);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.repeatedVertexTriangleCount).toBe(0);
    expect(after.triangleCount).toBe(1);
  });

  it("removes an exact-zero-area triangle when removeExact is true", async () => {
    const result = await removeDegenerateTriangles(zeroAreaCollinearTriangle(), { removeExact: true, removeNearZero: false });
    expect(result.exactZeroAreaRemoved).toBe(1);
  });

  it("leaves near-zero-area triangles untouched when removeNearZero is false", async () => {
    const result = await removeDegenerateTriangles(nearZeroAreaTriangle(), { removeExact: true, removeNearZero: false });
    expect(result.nearZeroAreaRemoved).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.nearZeroAreaTriangleCount).toBe(1);
  });

  it("removes near-zero-area triangles when removeNearZero is true", async () => {
    const result = await removeDegenerateTriangles(nearZeroAreaTriangle(), { removeExact: true, removeNearZero: true });
    expect(result.nearZeroAreaRemoved).toBe(1);
  });

  it("never mutates the input buffer", async () => {
    const input = repeatedPositionDegeneracy();
    const copy = input.slice();
    await removeDegenerateTriangles(input, { removeExact: true, removeNearZero: true });
    expect(input).toEqual(copy);
  });

  it("leaves a clean mesh with zero removals", async () => {
    const result = await removeDegenerateTriangles(outwardClosedCube(), { removeExact: true, removeNearZero: true });
    expect(result.repeatedVertexRemoved).toBe(0);
    expect(result.exactZeroAreaRemoved).toBe(0);
    expect(result.nearZeroAreaRemoved).toBe(0);
  });
});

describe("removeDuplicateFaces", () => {
  it("removes a same-winding duplicate, keeping exactly one copy", async () => {
    const result = await removeDuplicateFaces(duplicateFaceSameWinding());
    expect(result.sameWindingRemoved).toBe(1);
    expect(result.reverseWindingRemoved).toBe(0);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.sameWindingDuplicateFaceCount).toBe(0);
    expect(after.reverseWindingDuplicateFaceCount).toBe(0);
  });

  it("removes a reverse-winding duplicate entirely, keeping the earlier winding", async () => {
    const result = await removeDuplicateFaces(duplicateFaceReverseWinding());
    expect(result.reverseWindingRemoved).toBe(1);
    const after = await analyzeSTLDiagnostics(result.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS);
    expect(after.sameWindingDuplicateFaceCount).toBe(0);
    expect(after.reverseWindingDuplicateFaceCount).toBe(0);
  });

  it("never mutates the input buffer", async () => {
    const input = duplicateFaceSameWinding();
    const copy = input.slice();
    await removeDuplicateFaces(input);
    expect(input).toEqual(copy);
  });

  it("leaves a clean mesh with zero removals", async () => {
    const result = await removeDuplicateFaces(outwardClosedCube());
    expect(result.sameWindingRemoved).toBe(0);
    expect(result.reverseWindingRemoved).toBe(0);
  });
});
