import { describe, expect, it } from "vitest";
import { convertSTLToThreeMF } from "./convert";
import { DEFAULT_STL_TO_THREEMF_LIMITS } from "./types";
import { degenerateTriangleSTL, expectSTLToThreeMFErrorAsync, simpleTriangleSTL, twoTriangleQuadSTL } from "./test-fixtures";
import { buildAsciiSTLText, textToBuffer } from "../stl/test-fixtures";
import { openThreeMFPackage } from "../threemf/package";
import { findPrimaryModelPath } from "../threemf/relationships";
import { parseThreeMFModel } from "../threemf/model-parser";
import { resolveScene } from "../threemf/resolve-scene";
import { convertThreeMFPackage } from "../threemf/convert";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { parseBinarySTL } from "../stl/parse-binary";
import { computeBounds } from "../stl/bounds";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { DEFAULT_THREEMF_LIMITS } from "../threemf/types";

describe("convertSTLToThreeMF — basic conversion", () => {
  it("converts a binary STL triangle", async () => {
    const result = await convertSTLToThreeMF(simpleTriangleSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);
    expect(result.inputEncoding).toBe("binary");
    expect(result.inputTriangleCount).toBe(1);
    expect(result.outputTriangleCount).toBe(1);
    expect(result.uniqueVertexCount).toBe(3);
    expect(result.skippedDegenerateTriangles).toBe(0);
    expect(result.declaredUnit).toBe("millimeter");
    expect(result.coordinateScale).toBe(1);
  });

  it("converts an ASCII STL triangle to equivalent 3MF geometry as the same binary triangle", async () => {
    const asciiText = buildAsciiSTLText([{ normal: [0, 0, 1], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }]);
    const asciiResult = await convertSTLToThreeMF(textToBuffer(asciiText), DEFAULT_STL_TO_THREEMF_LIMITS);
    const binaryResult = await convertSTLToThreeMF(simpleTriangleSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);

    expect(asciiResult.inputEncoding).toBe("ascii");
    expect(asciiResult.outputTriangleCount).toBe(binaryResult.outputTriangleCount);
    expect(asciiResult.uniqueVertexCount).toBe(binaryResult.uniqueVertexCount);
    expect(asciiResult.bounds).toEqual(binaryResult.bounds);
  });

  it("deduplicates a shared edge across two triangles", async () => {
    const result = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);
    expect(result.sourceTriangleVertexCount).toBe(6);
    expect(result.uniqueVertexCount).toBe(4);
    expect(result.duplicateVertexReferencesRemoved).toBe(2);
  });

  it("preserves numeric coordinates exactly, with no scaling", async () => {
    const result = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);
    expect(result.bounds.size[0]).toBeCloseTo(2, 5);
    expect(result.bounds.size[1]).toBeCloseTo(2, 5);
  });
});

describe("convertSTLToThreeMF — degenerate triangles", () => {
  it("rejects a file whose only triangle is degenerate", async () => {
    await expectSTLToThreeMFErrorAsync(() => convertSTLToThreeMF(degenerateTriangleSTL(), DEFAULT_STL_TO_THREEMF_LIMITS), "THREEMF_NO_OUTPUT_GEOMETRY");
  });
});

describe("convertSTLToThreeMF — round trip through the production 3MF reader", () => {
  it("the generated package opens with openThreeMFPackage/findPrimaryModelPath/parseThreeMFModel/resolveScene", async () => {
    const result = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);

    const pkg = openThreeMFPackage(result.threeMFBuffer, DEFAULT_THREEMF_LIMITS);
    const modelPath = findPrimaryModelPath(pkg);
    const xml = new TextDecoder().decode(pkg.readEntry(modelPath));
    const model = parseThreeMFModel(xml, DEFAULT_THREEMF_LIMITS);
    expect(model.unit).toBe("millimeter");

    const scene = resolveScene(model, DEFAULT_THREEMF_LIMITS);
    expect(scene.triangleCount).toBe(result.outputTriangleCount);
    expect(scene.bounds).toEqual(result.bounds);
  });

  it("also opens via the convenience convertThreeMFPackage() entry point", async () => {
    const result = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);
    const reconverted = convertThreeMFPackage(result.threeMFBuffer, DEFAULT_THREEMF_LIMITS);
    expect(reconverted.sourceUnit).toBe("millimeter");
    expect(reconverted.triangleCount).toBe(result.outputTriangleCount);
    expect(reconverted.bounds).toEqual(result.bounds);
  });
});

describe("convertSTLToThreeMF — full STL -> 3MF -> STL round trip", () => {
  it("re-converting the generated 3MF back to STL preserves triangle count and bounds", async () => {
    const stlToThreeMF = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);

    const threeMFToStl = convertThreeMFPackage(stlToThreeMF.threeMFBuffer, DEFAULT_THREEMF_LIMITS);
    const stlBuffer = serializeBinarySTL({ positions: threeMFToStl.positions, normals: threeMFToStl.normals });
    const reparsed = parseBinarySTL(stlBuffer, DEFAULT_STL_LIMITS);

    expect(reparsed.triangleCount).toBe(stlToThreeMF.outputTriangleCount);
    expect(computeBounds(reparsed.positions)).toEqual(stlToThreeMF.bounds);
  });

  it("both binary and ASCII source STL encodings survive the full round trip identically", async () => {
    const asciiText = buildAsciiSTLText([
      { normal: [0, 0, 1], vertices: [[0, 0, 0], [2, 0, 0], [2, 2, 0]] },
      { normal: [0, 0, 1], vertices: [[0, 0, 0], [2, 2, 0], [0, 2, 0]] },
    ]);
    const fromAscii = await convertSTLToThreeMF(textToBuffer(asciiText), DEFAULT_STL_TO_THREEMF_LIMITS);
    const fromBinary = await convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS);

    const asciiScene = convertThreeMFPackage(fromAscii.threeMFBuffer, DEFAULT_THREEMF_LIMITS);
    const binaryScene = convertThreeMFPackage(fromBinary.threeMFBuffer, DEFAULT_THREEMF_LIMITS);
    expect(asciiScene.triangleCount).toBe(binaryScene.triangleCount);
    expect(asciiScene.bounds).toEqual(binaryScene.bounds);
  });
});

describe("convertSTLToThreeMF — cancellation and limits", () => {
  it("supports cancellation mid-pipeline", async () => {
    let cancelled = false;
    const promise = convertSTLToThreeMF(twoTriangleQuadSTL(), DEFAULT_STL_TO_THREEMF_LIMITS, () => cancelled);
    cancelled = true;
    try {
      await promise;
    } catch (error) {
      expect((error as Error).message).toBe("cancelled");
    }
  });

  it("enforces the unique-vertex limit", async () => {
    const limits = { ...DEFAULT_STL_TO_THREEMF_LIMITS, dedup: { maxUniqueVertices: 2 } };
    await expectSTLToThreeMFErrorAsync(() => convertSTLToThreeMF(twoTriangleQuadSTL(), limits), "THREEMF_VERTEX_LIMIT_EXCEEDED");
  });

  it("enforces the triangle limit", async () => {
    const limits = { ...DEFAULT_STL_TO_THREEMF_LIMITS, model: { maxTriangles: 1 } };
    await expectSTLToThreeMFErrorAsync(() => convertSTLToThreeMF(twoTriangleQuadSTL(), limits), "THREEMF_TRIANGLE_LIMIT_EXCEEDED");
  });

  it("reuses existing STL input errors for invalid STL files", async () => {
    await expectSTLToThreeMFErrorAsync(() => convertSTLToThreeMF(new ArrayBuffer(0), DEFAULT_STL_TO_THREEMF_LIMITS), "STL_EMPTY_GEOMETRY");
  });
});
