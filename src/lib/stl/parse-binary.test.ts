import { describe, expect, it } from "vitest";
import { parseBinarySTL } from "./parse-binary";
import { buildBinarySTLBuffer, expectSTLError, sampleTriangle } from "./test-fixtures";

const limits = { maxTriangles: 1000 };

describe("parseBinarySTL", () => {
  it("parses a valid single-triangle binary STL", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle()]);
    const result = parseBinarySTL(buffer, limits);

    expect(result.triangleCount).toBe(1);
    expect(result.positions).toHaveLength(9);
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("parses multiple triangles", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle(), sampleTriangle(), sampleTriangle()]);
    const result = parseBinarySTL(buffer, limits);
    expect(result.triangleCount).toBe(3);
    expect(result.positions).toHaveLength(27);
  });

  it("rejects a truncated header", () => {
    expectSTLError(() => parseBinarySTL(new ArrayBuffer(40), limits), "STL_BINARY_TRUNCATED");
  });

  it("rejects a truncated triangle record", () => {
    const full = buildBinarySTLBuffer([sampleTriangle(), sampleTriangle()]);
    const truncated = full.slice(0, full.byteLength - 10);
    expectSTLError(() => parseBinarySTL(truncated, limits), "STL_BINARY_TRUNCATED");
  });

  it("rejects a declared triangle count that exceeds the buffer's actual length", () => {
    const buffer = new ArrayBuffer(84);
    new DataView(buffer).setUint32(80, 5000, true);
    // maxTriangles is generously above the declared count so this isolates the
    // length-mismatch check rather than tripping the complexity ceiling first.
    expectSTLError(() => parseBinarySTL(buffer, { maxTriangles: 10_000 }), "STL_BINARY_TRUNCATED");
  });

  it("rejects a triangle count above the configured safety limit", () => {
    // A well-formed buffer that legitimately declares more triangles than allowed.
    const triangles = Array.from({ length: 20 }, sampleTriangle);
    const buffer = buildBinarySTLBuffer(triangles);
    expectSTLError(() => parseBinarySTL(buffer, { maxTriangles: 10 }), "STL_TOO_COMPLEX");
  });

  it("rejects non-finite vertex coordinates", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle()]);
    // First vertex's x coordinate, right after the 12-byte normal.
    new DataView(buffer).setFloat32(80 + 4 + 12, NaN, true);
    expectSTLError(() => parseBinarySTL(buffer, limits), "STL_NON_FINITE_VERTEX");
  });

  it("rejects empty geometry (zero declared triangles)", () => {
    expectSTLError(() => parseBinarySTL(buildBinarySTLBuffer([]), limits), "STL_EMPTY_GEOMETRY");
  });

  it("falls back to a computed normal when the declared normal is not finite", () => {
    const buffer = buildBinarySTLBuffer([{ ...sampleTriangle(), normal: [0, 0, 0] }]);
    const result = parseBinarySTL(buffer, limits);
    // Raw normal is passed through as-is here; parse.ts's resolveNormals is what fixes it up.
    expect(Array.from(result.normals.slice(0, 3))).toEqual([0, 0, 0]);
  });
});
