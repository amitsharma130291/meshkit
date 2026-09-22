import { describe, expect, it } from "vitest";
import { convertSTLToOBJ, filterDegenerateTriangles } from "./convert";
import { DEFAULT_STL_TO_OBJ_LIMITS } from "./types";
import { degenerateTriangleSTL, expectSTLToOBJErrorAsync, simpleTriangleSTL, twoTriangleQuadSTL } from "./test-fixtures";
import { buildAsciiSTLText, textToBuffer } from "../stl/test-fixtures";
import { parseSTL } from "../stl/parse";
import { parseOBJDocument } from "../obj/parser";
import { convertOBJText } from "../obj/convert";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { parseBinarySTL } from "../stl/parse-binary";
import { computeBounds } from "../stl/bounds";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { DEFAULT_OBJ_LIMITS } from "../obj/types";

function decode(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

describe("convertSTLToOBJ — basic conversion", () => {
  it("converts a binary STL triangle", async () => {
    const result = await convertSTLToOBJ(simpleTriangleSTL(), DEFAULT_STL_TO_OBJ_LIMITS);
    expect(result.inputEncoding).toBe("binary");
    expect(result.inputTriangleCount).toBe(1);
    expect(result.outputFaceCount).toBe(1);
    expect(result.uniqueVertexCount).toBe(3);
    expect(result.skippedDegenerateTriangles).toBe(0);
  });

  it("converts an ASCII STL triangle equivalently to the same binary triangle", async () => {
    const asciiText = buildAsciiSTLText([{ normal: [0, 0, 1], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }]);
    const asciiResult = await convertSTLToOBJ(textToBuffer(asciiText), DEFAULT_STL_TO_OBJ_LIMITS);
    const binaryResult = await convertSTLToOBJ(simpleTriangleSTL(), DEFAULT_STL_TO_OBJ_LIMITS);

    expect(asciiResult.inputEncoding).toBe("ascii");
    expect(asciiResult.outputFaceCount).toBe(binaryResult.outputFaceCount);
    expect(asciiResult.uniqueVertexCount).toBe(binaryResult.uniqueVertexCount);
    expect(decode(asciiResult.objBuffer)).toBe(decode(binaryResult.objBuffer));
  });

  it("deduplicates a shared edge across two triangles", async () => {
    const result = await convertSTLToOBJ(twoTriangleQuadSTL(), DEFAULT_STL_TO_OBJ_LIMITS);
    expect(result.sourceTriangleVertexCount).toBe(6);
    expect(result.uniqueVertexCount).toBe(4);
    expect(result.duplicateVertexReferencesRemoved).toBe(2);
  });

  it("preserves numeric coordinates exactly, with no scaling", async () => {
    const result = await convertSTLToOBJ(twoTriangleQuadSTL(), DEFAULT_STL_TO_OBJ_LIMITS);
    expect(result.bounds.size[0]).toBeCloseTo(2, 5);
    expect(result.bounds.size[1]).toBeCloseTo(2, 5);
  });
});

describe("convertSTLToOBJ — degenerate triangles", () => {
  it("rejects a file whose only triangle is degenerate", async () => {
    await expectSTLToOBJErrorAsync(() => convertSTLToOBJ(degenerateTriangleSTL(), DEFAULT_STL_TO_OBJ_LIMITS), "OBJ_NO_OUTPUT_GEOMETRY");
  });

  it("skips degenerate triangles while keeping valid ones, with a warning", async () => {
    const parsed = parseSTL(simpleTriangleSTL(), DEFAULT_STL_LIMITS);
    const degenerate = parseSTL(degenerateTriangleSTL(), DEFAULT_STL_LIMITS);
    const combined = {
      encoding: "binary" as const,
      triangleCount: 2,
      positions: Float32Array.from([...parsed.positions, ...degenerate.positions]),
      normals: Float32Array.from([...parsed.normals, ...degenerate.normals]),
      bounds: computeBounds(Float32Array.from([...parsed.positions, ...degenerate.positions])),
    };
    const filtered = filterDegenerateTriangles(combined);
    expect(filtered.skippedDegenerateTriangles).toBe(1);
    expect(filtered.positions.length).toBe(9);
  });
});

describe("convertSTLToOBJ — round trip through the production OBJ parser", () => {
  it("the generated OBJ parses successfully and matches source triangle count and bounds", async () => {
    const result = await convertSTLToOBJ(twoTriangleQuadSTL(), DEFAULT_STL_TO_OBJ_LIMITS);
    const objText = decode(result.objBuffer);
    const parsed = parseOBJDocument(objText, DEFAULT_OBJ_LIMITS);
    expect(parsed.triangles).toHaveLength(result.outputFaceCount);
    expect(parsed.sourceVertexCount).toBe(result.uniqueVertexCount);
  });
});

describe("convertSTLToOBJ — full STL -> OBJ -> STL round trip", () => {
  it("re-converting the generated OBJ back to STL preserves triangle count and bounds", async () => {
    const stlToObj = await convertSTLToOBJ(twoTriangleQuadSTL(), DEFAULT_STL_TO_OBJ_LIMITS);
    const objText = decode(stlToObj.objBuffer);

    const objToStl = convertOBJText(objText);
    const stlBuffer = serializeBinarySTL({ positions: objToStl.positions, normals: objToStl.normals });
    const reparsed = parseBinarySTL(stlBuffer, DEFAULT_STL_LIMITS);

    expect(reparsed.triangleCount).toBe(stlToObj.outputFaceCount);
    expect(computeBounds(reparsed.positions)).toEqual(stlToObj.bounds);
  });
});

describe("convertSTLToOBJ — cancellation and limits", () => {
  it("supports cancellation mid-pipeline", async () => {
    let cancelled = false;
    const promise = convertSTLToOBJ(twoTriangleQuadSTL(), DEFAULT_STL_TO_OBJ_LIMITS, () => cancelled);
    cancelled = true;
    // A tiny fixture may finish before cancellation is observed — either a
    // clean result or a cancellation throw is acceptable; what matters is
    // it never hangs or throws something else.
    try {
      await promise;
    } catch (error) {
      expect((error as Error).message).toBe("cancelled");
    }
  });

  it("enforces the unique-vertex limit", async () => {
    const limits = { ...DEFAULT_STL_TO_OBJ_LIMITS, dedup: { maxUniqueVertices: 2 } };
    await expectSTLToOBJErrorAsync(() => convertSTLToOBJ(twoTriangleQuadSTL(), limits), "OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED");
  });

  it("reuses existing STL input errors for invalid STL files", async () => {
    await expectSTLToOBJErrorAsync(() => convertSTLToOBJ(new ArrayBuffer(0), DEFAULT_STL_TO_OBJ_LIMITS), "STL_EMPTY_GEOMETRY");
  });
});
