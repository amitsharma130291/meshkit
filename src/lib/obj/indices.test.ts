import { describe, expect, it } from "vitest";
import { parseFaceVertexToken, resolveIndex } from "./indices";
import { expectOBJError } from "./test-fixtures";

describe("resolveIndex", () => {
  it("resolves a positive one-based index", () => {
    expect(resolveIndex(1, 5)).toBe(0);
    expect(resolveIndex(5, 5)).toBe(4);
  });

  it("resolves a negative index relative to the supplied count", () => {
    expect(resolveIndex(-1, 5)).toBe(4);
    expect(resolveIndex(-5, 5)).toBe(0);
  });

  it("rejects index zero", () => {
    expectOBJError(() => resolveIndex(0, 5), "OBJ_INDEX_ZERO");
  });

  it("rejects an out-of-range positive index", () => {
    expectOBJError(() => resolveIndex(6, 5), "OBJ_INDEX_OUT_OF_RANGE");
  });

  it("rejects an out-of-range negative index", () => {
    expectOBJError(() => resolveIndex(-6, 5), "OBJ_INDEX_OUT_OF_RANGE");
  });
});

describe("parseFaceVertexToken", () => {
  it("parses the bare 'v' form", () => {
    expect(parseFaceVertexToken("1", 3, 0, 0)).toEqual({ vertexIndex: 0, texCoordIndex: null, normalIndex: null });
  });

  it("parses the 'v/vt' form", () => {
    expect(parseFaceVertexToken("2/1", 3, 2, 0)).toEqual({ vertexIndex: 1, texCoordIndex: 0, normalIndex: null });
  });

  it("parses the 'v//vn' form", () => {
    expect(parseFaceVertexToken("2//1", 3, 0, 2)).toEqual({ vertexIndex: 1, texCoordIndex: null, normalIndex: 0 });
  });

  it("parses the 'v/vt/vn' form", () => {
    expect(parseFaceVertexToken("3/2/1", 3, 2, 2)).toEqual({ vertexIndex: 2, texCoordIndex: 1, normalIndex: 0 });
  });

  it("resolves a negative vertex index against the count at that point", () => {
    expect(parseFaceVertexToken("-1", 4, 0, 0)).toEqual({ vertexIndex: 3, texCoordIndex: null, normalIndex: null });
  });

  it("rejects index zero", () => {
    expectOBJError(() => parseFaceVertexToken("0", 3, 0, 0), "OBJ_INDEX_ZERO");
  });

  it("rejects an out-of-range vertex index", () => {
    expectOBJError(() => parseFaceVertexToken("9", 3, 0, 0), "OBJ_INDEX_OUT_OF_RANGE");
  });

  it("rejects a missing vertex index", () => {
    expectOBJError(() => parseFaceVertexToken("/1", 3, 2, 0), "OBJ_FACE_INVALID");
  });

  it("rejects a malformed trailing separator", () => {
    expectOBJError(() => parseFaceVertexToken("1/", 3, 2, 0), "OBJ_FACE_INVALID");
    expectOBJError(() => parseFaceVertexToken("1//", 3, 0, 2), "OBJ_FACE_INVALID");
    expectOBJError(() => parseFaceVertexToken("1/2/", 3, 2, 2), "OBJ_FACE_INVALID");
  });

  it("rejects too many slash-separated fields", () => {
    expectOBJError(() => parseFaceVertexToken("1/2/3/4", 3, 2, 2), "OBJ_FACE_INVALID");
  });

  it("rejects a non-integer field", () => {
    expectOBJError(() => parseFaceVertexToken("1.5", 3, 0, 0), "OBJ_FACE_INVALID");
    expectOBJError(() => parseFaceVertexToken("abc", 3, 0, 0), "OBJ_FACE_INVALID");
  });
});
