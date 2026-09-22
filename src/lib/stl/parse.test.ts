import { describe, expect, it } from "vitest";
import { parseSTL } from "./parse";
import { toSTLSafeError } from "./errors";
import { buildAsciiSTLText, buildBinarySTLBuffer, sampleTriangle, textToBuffer } from "./test-fixtures";

const limits = { maxTriangles: 1000 };

describe("parseSTL", () => {
  it("parses binary STL end to end, including bounds", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle()]);
    const result = parseSTL(buffer, limits);

    expect(result.encoding).toBe("binary");
    expect(result.triangleCount).toBe(1);
    expect(result.bounds.max).toEqual([1, 1, 0]);
  });

  it("parses ASCII STL end to end", () => {
    const buffer = textToBuffer(buildAsciiSTLText([sampleTriangle()]));
    const result = parseSTL(buffer, limits);

    expect(result.encoding).toBe("ascii");
    expect(result.triangleCount).toBe(1);
  });

  it("correctly identifies a binary STL whose header begins with 'solid'", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle(), sampleTriangle()], "solid made by ExampleSlicer");
    const result = parseSTL(buffer, limits);
    expect(result.encoding).toBe("binary");
    expect(result.triangleCount).toBe(2);
  });

  it("keeps a valid declared normal (normalized) rather than recomputing it", () => {
    const buffer = buildBinarySTLBuffer([{ ...sampleTriangle(), normal: [0, 0, 2] }]); // not unit length
    const result = parseSTL(buffer, limits);
    expect(result.normals[0]).toBeCloseTo(0, 6);
    expect(result.normals[1]).toBeCloseTo(0, 6);
    expect(result.normals[2]).toBeCloseTo(1, 6);
  });

  it("computes a face normal from vertices when the declared normal is unusable", () => {
    const buffer = buildBinarySTLBuffer([{ ...sampleTriangle(), normal: [0, 0, 0] }]);
    const result = parseSTL(buffer, limits);
    // sampleTriangle() is in the XY plane, so its face normal should point along +/-Z.
    expect(Math.abs(result.normals[2])).toBeCloseTo(1, 6);
    expect(result.normals[0]).toBeCloseTo(0, 6);
    expect(result.normals[1]).toBeCloseTo(0, 6);
  });

  it("rejects a completely empty buffer", () => {
    expect(() => parseSTL(new ArrayBuffer(0), limits)).toThrow();
  });

  it("maps an unrecognized, non-STL buffer to STL_FORMAT_UNRECOGNIZED via the safe-error mapper", () => {
    // Long enough to pass the length check, but matches neither the binary
    // length formula nor the ASCII grammar, and fails to parse as either.
    const buffer = textToBuffer("not an stl file ".repeat(10));
    try {
      parseSTL(buffer, limits);
      expect.fail("expected parseSTL to throw");
    } catch (error) {
      expect(toSTLSafeError(error).code).toBe("STL_FORMAT_UNRECOGNIZED");
    }
  });
});
