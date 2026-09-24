import { describe, expect, it } from "vitest";
import {
  ALL_BATCH_OPERATION_IDS,
  getAdapter,
  unwrapConversionResult,
  unwrapOptimizeResult,
  unwrapRepairResult,
} from "./adapter-registry";
import { projectObjToStlMeta } from "./conversion-result-meta";

describe("getAdapter — registry completeness", () => {
  it.each(ALL_BATCH_OPERATION_IDS)("has a registered adapter for %s", (id) => {
    const adapter = getAdapter(id);
    expect(adapter.operationId).toBe(id);
    expect(adapter.acceptedExtensions.length).toBeGreaterThan(0);
    expect(adapter.outputExtension).toBeTruthy();
    expect(adapter.memoryMultiplier).toBeGreaterThan(1);
  });

  it("maps every conversion operation to the correct accepted/output extensions", () => {
    expect(getAdapter("convert-3mf-to-stl")).toMatchObject({ acceptedExtensions: ["3mf"], outputExtension: "stl" });
    expect(getAdapter("convert-obj-to-stl")).toMatchObject({ acceptedExtensions: ["obj"], outputExtension: "stl" });
    expect(getAdapter("convert-glb-to-stl")).toMatchObject({ acceptedExtensions: ["glb"], outputExtension: "stl" });
    expect(getAdapter("convert-ply-to-stl")).toMatchObject({ acceptedExtensions: ["ply"], outputExtension: "stl" });
    expect(getAdapter("convert-stl-to-obj")).toMatchObject({ acceptedExtensions: ["stl"], outputExtension: "obj" });
    expect(getAdapter("convert-stl-to-3mf")).toMatchObject({ acceptedExtensions: ["stl"], outputExtension: "3mf" });
  });

  it("repair and optimize both accept and emit stl", () => {
    expect(getAdapter("repair-stl")).toMatchObject({ acceptedExtensions: ["stl"], outputExtension: "stl" });
    expect(getAdapter("optimize-stl")).toMatchObject({ acceptedExtensions: ["stl"], outputExtension: "stl" });
  });
});

describe("unwrapConversionResult — Phase 10 hotfix: explicit projection, never a raw spread", () => {
  it("extracts outputBytes from the given buffer key and projects resultMeta through the supplied projector — never the raw record", () => {
    const raw = { triangleCount: 10, warnings: [], stlBuffer: new ArrayBuffer(8) };
    const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectObjToStlMeta);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.outputBytes.byteLength).toBe(8);
    expect(unwrapped!.resultMeta).toMatchObject({ triangleCount: 10, warnings: [] });
  });

  it("returns null when the expected buffer key is missing", () => {
    expect(unwrapConversionResult({ triangleCount: 10 }, "stlBuffer", projectObjToStlMeta)).toBeNull();
  });

  it("STAGE 1 — REGRESSION: never places the raw positions/normals geometry arrays into resultMeta, however large", () => {
    // A representative real conversion result — the worker also returns
    // positions/normals for the single-file viewport preview, and the
    // confirmed defect was that ALL of it used to end up in resultMeta.
    const raw = {
      positions: new Float32Array(300_000),
      normals: new Float32Array(300_000),
      triangleCount: 100_000,
      sourceVertexCount: 50_000,
      sourceFaceCount: 100_000,
      objectCount: 1,
      groupCount: 1,
      materialLibraryCount: 0,
      usedMaterialCount: 0,
      ignoredLineCount: 0,
      ignoredPointCount: 0,
      bounds: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
      warnings: [],
      stlBuffer: new ArrayBuffer(8),
    };
    const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectObjToStlMeta);
    expect(unwrapped).not.toBeNull();
    // The assertion inspects the GENERATED report object itself, not source text.
    const resultMeta = unwrapped!.resultMeta as Record<string, unknown>;
    expect(resultMeta).not.toHaveProperty("positions");
    expect(resultMeta).not.toHaveProperty("normals");
    expect(Object.values(resultMeta)).not.toContain(raw.positions);
    expect(Object.values(resultMeta)).not.toContain(raw.normals);
  });

  it("STAGE 1 — REGRESSION: a sufficiently large synthetic result no longer produces an unbounded resultMeta (proves the RangeError-on-serialize problem is gone at the source)", () => {
    // Large enough that the OLD spread-based implementation would have produced
    // a resultMeta whose JSON.stringify output is tens of megabytes; kept well
    // below any size that would itself stress the test runner.
    const hugeLength = 2_000_000;
    const raw = {
      positions: new Float32Array(hugeLength),
      normals: new Float32Array(hugeLength),
      triangleCount: hugeLength / 3,
      sourceVertexCount: hugeLength / 3,
      sourceFaceCount: hugeLength / 9,
      objectCount: 1,
      groupCount: 1,
      materialLibraryCount: 0,
      usedMaterialCount: 0,
      ignoredLineCount: 0,
      ignoredPointCount: 0,
      bounds: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
      warnings: [],
      stlBuffer: new ArrayBuffer(8),
    };
    const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectObjToStlMeta);
    const serialized = JSON.stringify(unwrapped!.resultMeta);
    expect(serialized.length).toBeLessThan(2000);
  });
});

describe("unwrapRepairResult — honest outcome handling", () => {
  it("succeeds when outputBytes exists, regardless of outcome (repair always reparses+reverifies before this point)", () => {
    const raw = { mode: "repair", repair: { outcome: "unable-to-repair-safely", outputBytes: new ArrayBuffer(4), trianglesBefore: 10, trianglesAfter: 10 } };
    const unwrapped = unwrapRepairResult(raw);
    expect(unwrapped).not.toBeNull();
    expect((unwrapped!.resultMeta as { outcome: string }).outcome).toBe("unable-to-repair-safely");
  });

  it("fails when outputBytes is null (failed/cancelled before serialization)", () => {
    const raw = { mode: "repair", repair: { outcome: "failed", outputBytes: null } };
    expect(unwrapRepairResult(raw)).toBeNull();
  });

  it("returns null for a malformed/unexpected raw shape", () => {
    expect(unwrapRepairResult({ mode: "plan", plan: {} })).toBeNull();
  });
});

describe("unwrapOptimizeResult — verification-failed is never treated as success even if output bytes exist", () => {
  it("succeeds for target-achieved", () => {
    const raw = { mode: "optimize", optimize: { outcome: "target-achieved", outputBytes: new ArrayBuffer(4) } };
    expect(unwrapOptimizeResult(raw)).not.toBeNull();
  });

  it("succeeds for partially-reduced and unchanged-no-safe-collapses (legitimate, verified terminal states)", () => {
    expect(unwrapOptimizeResult({ mode: "optimize", optimize: { outcome: "partially-reduced", outputBytes: new ArrayBuffer(4) } })).not.toBeNull();
    expect(unwrapOptimizeResult({ mode: "optimize", optimize: { outcome: "unchanged-no-safe-collapses", outputBytes: new ArrayBuffer(4) } })).not.toBeNull();
  });

  it("FAILS for verification-failed even when outputBytes is non-null", () => {
    const raw = { mode: "optimize", optimize: { outcome: "verification-failed", outputBytes: new ArrayBuffer(4) } };
    expect(unwrapOptimizeResult(raw)).toBeNull();
  });

  it("FAILS for verification-incomplete even when outputBytes is non-null", () => {
    const raw = { mode: "optimize", optimize: { outcome: "verification-incomplete", outputBytes: new ArrayBuffer(4) } };
    expect(unwrapOptimizeResult(raw)).toBeNull();
  });

  it("fails when outputBytes is null regardless of outcome", () => {
    const raw = { mode: "optimize", optimize: { outcome: "target-achieved", outputBytes: null } };
    expect(unwrapOptimizeResult(raw)).toBeNull();
  });
});
