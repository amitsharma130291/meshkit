import { describe, expect, it } from "vitest";
import {
  CONVERSION_RESULT_META_ALLOWED_KEYS,
  projectGlbToStlMeta,
  projectObjToStlMeta,
  projectPlyToStlMeta,
  projectStlToObjMeta,
  projectStlToThreeMFMeta,
  projectThreeMFToStlMeta,
} from "./conversion-result-meta";

const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], size: [1, 1, 1] as [number, number, number], center: [0.5, 0.5, 0.5] as [number, number, number] };

function bigFloat32(length: number): Float32Array {
  return new Float32Array(length);
}

describe("projectObjToStlMeta — Stage 1/3: real conversion result, forbidden fields excluded", () => {
  const rawResult = {
    positions: bigFloat32(300_000),
    normals: bigFloat32(300_000),
    triangleCount: 100_000,
    sourceVertexCount: 50_000,
    sourceFaceCount: 100_000,
    objectCount: 1,
    groupCount: 1,
    materialLibraryCount: 0,
    usedMaterialCount: 0,
    ignoredLineCount: 0,
    ignoredPointCount: 0,
    bounds,
    warnings: [{ code: "materials-not-preserved", message: "Materials are not preserved in STL output." }],
    stlBuffer: new ArrayBuffer(8),
  };

  it("never includes the raw positions or normals arrays — inspects the generated report object, not source text", () => {
    const meta = projectObjToStlMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    // Defensive: even if a key existed, it must never be the actual typed array instance.
    expect(Object.values(meta)).not.toContain(rawResult.positions);
    expect(Object.values(meta)).not.toContain(rawResult.normals);
  });

  it("never includes the output buffer", () => {
    const meta = projectObjToStlMeta(rawResult as never);
    expect(meta).not.toHaveProperty("stlBuffer");
  });

  it("preserves every legitimate summary field", () => {
    const meta = projectObjToStlMeta(rawResult as never);
    expect(meta).toMatchObject({
      triangleCount: 100_000,
      sourceVertexCount: 50_000,
      sourceFaceCount: 100_000,
      objectCount: 1,
      groupCount: 1,
      materialLibraryCount: 0,
      usedMaterialCount: 0,
      ignoredLineCount: 0,
      ignoredPointCount: 0,
      bounds,
      warnings: [{ code: "materials-not-preserved", message: "Materials are not preserved in STL output." }],
    });
  });

  it("the projected metadata's own keys are an exact subset of the declared allowlist for this operation", () => {
    const meta = projectObjToStlMeta(rawResult as never);
    const allowed = CONVERSION_RESULT_META_ALLOWED_KEYS["convert-obj-to-stl"];
    for (const key of Object.keys(meta)) expect(allowed.has(key)).toBe(true);
  });

  it("stays small regardless of source geometry complexity (proves the fix removes the unbounded-serialization problem)", () => {
    const huge = { ...rawResult, positions: bigFloat32(6_000_000), normals: bigFloat32(6_000_000), triangleCount: 2_000_000 };
    const meta = projectObjToStlMeta(huge as never);
    expect(JSON.stringify(meta).length).toBeLessThan(2000);
  });
});

describe("projectThreeMFToStlMeta", () => {
  const rawResult = {
    positions: bigFloat32(9),
    normals: bigFloat32(9),
    stlBuffer: new ArrayBuffer(8),
    triangleCount: 1,
    objectCount: 1,
    buildItemCount: 1,
    componentInstanceCount: 0,
    sourceUnit: "millimeter",
    outputScale: "millimeter",
    bounds,
    warnings: [],
  };

  it("excludes positions/normals/stlBuffer, keeps the rest", () => {
    const meta = projectThreeMFToStlMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    expect(meta).not.toHaveProperty("stlBuffer");
    expect(meta).toMatchObject({ triangleCount: 1, objectCount: 1, buildItemCount: 1, componentInstanceCount: 0, sourceUnit: "millimeter", outputScale: "millimeter", bounds, warnings: [] });
  });
});

describe("projectGlbToStlMeta", () => {
  const rawResult = {
    positions: bigFloat32(9),
    normals: bigFloat32(9),
    triangleCount: 1,
    sourceVertexCount: 3,
    meshCount: 1,
    primitiveCount: 1,
    nodeInstanceCount: 1,
    sceneName: "Scene",
    skippedDegenerateTriangles: 0,
    skippedUnsupportedPrimitives: 0,
    bounds,
    warnings: [],
    stlBuffer: new ArrayBuffer(8),
    sourceUnits: "meter",
    outputScale: "millimeter",
    scaleFactor: 1000,
  };

  it("excludes positions/normals/stlBuffer, keeps the rest including optional sceneName", () => {
    const meta = projectGlbToStlMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    expect(meta).not.toHaveProperty("stlBuffer");
    expect(meta).toMatchObject({ triangleCount: 1, sourceVertexCount: 3, meshCount: 1, sceneName: "Scene", sourceUnits: "meter", outputScale: "millimeter", scaleFactor: 1000 });
  });

  it("omits sceneName cleanly when absent (never a fabricated empty string)", () => {
    const { sceneName: _drop, ...withoutName } = rawResult;
    const meta = projectGlbToStlMeta(withoutName as never);
    expect(meta).not.toHaveProperty("sceneName");
  });
});

describe("projectPlyToStlMeta", () => {
  const rawResult = {
    positions: bigFloat32(9),
    normals: bigFloat32(9),
    triangleCount: 1,
    sourceVertexCount: 3,
    sourceFaceCount: 1,
    vertexPropertyCount: 3,
    facePropertyCount: 1,
    unknownElementCount: 0,
    unknownPropertyCount: 0,
    format: "ascii",
    bounds,
    warnings: [],
    stlBuffer: new ArrayBuffer(8),
  };

  it("excludes positions/normals/stlBuffer, keeps the rest", () => {
    const meta = projectPlyToStlMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    expect(meta).not.toHaveProperty("stlBuffer");
    expect(meta).toMatchObject({ triangleCount: 1, sourceVertexCount: 3, sourceFaceCount: 1, format: "ascii" });
  });
});

describe("projectStlToObjMeta", () => {
  const rawResult = {
    positions: bigFloat32(9),
    normals: bigFloat32(9),
    objBuffer: new ArrayBuffer(8),
    inputEncoding: "binary",
    inputTriangleCount: 1,
    outputFaceCount: 1,
    sourceTriangleVertexCount: 3,
    uniqueVertexCount: 3,
    duplicateVertexReferencesRemoved: 0,
    skippedDegenerateTriangles: 0,
    outputByteLength: 100,
    bounds,
    warnings: [],
  };

  it("excludes positions/normals/objBuffer, keeps the rest", () => {
    const meta = projectStlToObjMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    expect(meta).not.toHaveProperty("objBuffer");
    expect(meta).toMatchObject({ inputEncoding: "binary", inputTriangleCount: 1, outputFaceCount: 1, uniqueVertexCount: 3, outputByteLength: 100 });
  });
});

describe("projectStlToThreeMFMeta", () => {
  const rawResult = {
    positions: bigFloat32(9),
    normals: bigFloat32(9),
    threeMFBuffer: new ArrayBuffer(8),
    inputEncoding: "ascii",
    inputTriangleCount: 1,
    outputTriangleCount: 1,
    sourceTriangleVertexCount: 3,
    uniqueVertexCount: 3,
    duplicateVertexReferencesRemoved: 0,
    skippedDegenerateTriangles: 0,
    declaredUnit: "millimeter",
    coordinateScale: 1,
    outputByteLength: 100,
    bounds,
    warnings: [],
  };

  it("excludes positions/normals/threeMFBuffer, keeps the rest", () => {
    const meta = projectStlToThreeMFMeta(rawResult as never);
    expect(meta).not.toHaveProperty("positions");
    expect(meta).not.toHaveProperty("normals");
    expect(meta).not.toHaveProperty("threeMFBuffer");
    expect(meta).toMatchObject({ inputEncoding: "ascii", inputTriangleCount: 1, outputTriangleCount: 1, declaredUnit: "millimeter", coordinateScale: 1, outputByteLength: 100 });
  });
});

describe("CONVERSION_RESULT_META_ALLOWED_KEYS — the explicit contract used by the Stage 4 report guard", () => {
  it("declares a non-empty, forbidden-field-free allowlist for every one of the six conversion operations", () => {
    const ids = ["convert-3mf-to-stl", "convert-obj-to-stl", "convert-glb-to-stl", "convert-ply-to-stl", "convert-stl-to-obj", "convert-stl-to-3mf"] as const;
    for (const id of ids) {
      const allowed = CONVERSION_RESULT_META_ALLOWED_KEYS[id];
      expect(allowed.size).toBeGreaterThan(0);
      expect(allowed.has("positions")).toBe(false);
      expect(allowed.has("normals")).toBe(false);
      expect(allowed.has("stlBuffer")).toBe(false);
      expect(allowed.has("objBuffer")).toBe(false);
      expect(allowed.has("threeMFBuffer")).toBe(false);
    }
  });
});
