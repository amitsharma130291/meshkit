import { describe, expect, it } from "vitest";
import { parseAsciiSTL } from "./parse-ascii";
import { buildAsciiSTLText, expectSTLError, sampleTriangle } from "./test-fixtures";

const limits = { maxTriangles: 1000 };

describe("parseAsciiSTL", () => {
  it("parses a valid single-triangle ASCII STL", () => {
    const text = buildAsciiSTLText([sampleTriangle()]);
    const result = parseAsciiSTL(text, limits);
    expect(result.triangleCount).toBe(1);
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(result.header).toBe("fixture");
  });

  it("accepts scientific notation vertices", () => {
    const text = [
      "solid sci",
      "facet normal 0 0 1",
      "outer loop",
      "vertex 1.5e-3 -2.25E2 0",
      "vertex 1 0 0",
      "vertex 0 1 0",
      "endloop",
      "endfacet",
      "endsolid sci",
    ].join("\n");

    const result = parseAsciiSTL(text, limits);
    expect(result.positions[0]).toBeCloseTo(0.0015, 6);
    expect(result.positions[1]).toBeCloseTo(-225, 6);
  });

  it("accepts mixed whitespace, tabs and blank lines", () => {
    const text =
      "solid\tmixed\n\n  facet   normal\t0 0 1\n\touter loop\r\n" +
      "vertex 0 0 0\nvertex\t1 0 0\n   vertex 0 1 0  \nendloop\nendfacet\n\nendsolid mixed\n";

    const result = parseAsciiSTL(text, limits);
    expect(result.triangleCount).toBe(1);
  });

  it("accepts uppercase and mixed-case keywords", () => {
    const text = [
      "SOLID upper",
      "FACET NORMAL 0 0 1",
      "Outer Loop",
      "VERTEX 0 0 0",
      "vertex 1 0 0",
      "Vertex 0 1 0",
      "ENDLOOP",
      "EndFacet",
      "ENDSOLID upper",
    ].join("\n");

    const result = parseAsciiSTL(text, limits);
    expect(result.triangleCount).toBe(1);
  });

  it("rejects an incomplete facet (missing endfacet)", () => {
    const text = "solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\n";
    expectSTLError(() => parseAsciiSTL(text, limits), "STL_ASCII_MALFORMED");
  });

  it("rejects a facet with fewer than three vertices", () => {
    const text =
      "solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid s\n";
    expectSTLError(() => parseAsciiSTL(text, limits), "STL_ASCII_MALFORMED");
  });

  it("rejects a facet with more than three vertices", () => {
    const text =
      "solid s\nfacet normal 0 0 1\nouter loop\n" +
      "vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nvertex 1 1 0\n" +
      "endloop\nendfacet\nendsolid s\n";
    expectSTLError(() => parseAsciiSTL(text, limits), "STL_ASCII_MALFORMED");
  });

  it("rejects non-finite coordinates", () => {
    const text =
      "solid s\nfacet normal 0 0 1\nouter loop\nvertex NaN 0 0\nvertex 1 0 0\nvertex 0 1 0\n" +
      "endloop\nendfacet\nendsolid s\n";
    expectSTLError(() => parseAsciiSTL(text, limits), "STL_NON_FINITE_VERTEX");
  });

  it("rejects empty geometry (a solid with no facets)", () => {
    expectSTLError(() => parseAsciiSTL("solid empty\nendsolid empty\n", limits), "STL_EMPTY_GEOMETRY");
  });

  it("rejects text that isn't STL at all", () => {
    expectSTLError(() => parseAsciiSTL("this is not an stl file", limits), "STL_ASCII_MALFORMED");
  });
});
