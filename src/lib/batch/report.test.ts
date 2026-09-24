import { describe, expect, it } from "vitest";
import type { SafeError } from "../errors";
import { BATCH_REPORT_SCHEMA_VERSION, buildDownloadableBatchReport } from "./report";
import { createBatchJob, type BatchJob } from "./types";

function makeJob(overrides: Partial<BatchJob> = {}): BatchJob {
  const file = new File([new Uint8Array(1024)], "C:\\Users\\amits\\secret\\part.stl", { type: "model/stl" });
  const job = createBatchJob({ file, displayName: "part.stl", operationId: "repair-stl", settings: { preset: "safe" } });
  return { ...job, ...overrides };
}

describe("buildDownloadableBatchReport — schema and structure", () => {
  it("carries a schema version, the operation, settings, and file-state counts", () => {
    const job = { ...makeJob(), state: "succeeded" as const, outputBytes: new ArrayBuffer(512), resultMeta: { outcome: "fully-repaired" } };
    const report = buildDownloadableBatchReport([job], "repair-stl", { preset: "safe" }, "generated");
    expect(report.schemaVersion).toBe(BATCH_REPORT_SCHEMA_VERSION);
    expect(report.operationId).toBe("repair-stl");
    expect(report.settings).toEqual({ preset: "safe" });
    expect(report.fileCountsByState.succeeded).toBe(1);
    expect(report.archiveStatus).toBe("generated");
  });

  it("includes one per-file entry with safe filename, sizes, outcome and warnings", () => {
    const job = {
      ...makeJob(),
      state: "succeeded" as const,
      outputBytes: new ArrayBuffer(512),
      resultMeta: { outcome: "fully-repaired", warnings: [{ code: "w1", message: "x" }] },
    };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "generated");
    expect(report.files).toHaveLength(1);
    expect(report.files[0].outputSize).toBe(512);
    expect(report.files[0].sourceSize).toBe(1024);
    expect(report.files[0].state).toBe("succeeded");
  });

  it("a failed job's entry has null outputSize and carries its error code", () => {
    const job = { ...makeJob(), state: "failed" as const, error: { code: "STL_TOO_COMPLEX", message: "too complex", recoverable: true } satisfies SafeError };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "not-generated");
    expect(report.files[0].outputSize).toBeNull();
    expect(report.files[0].errorCode).toBe("STL_TOO_COMPLEX");
  });
});

describe("buildDownloadableBatchReport — never leaks unsafe data", () => {
  it("never includes a local filesystem path — only the sanitized display name", () => {
    const job = { ...makeJob(), state: "succeeded" as const, outputBytes: new ArrayBuffer(4) };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "generated");
    const json = JSON.stringify(report);
    expect(json).not.toContain("C:\\Users");
    expect(json).not.toContain("secret");
    expect(report.files[0].safeFilename).toBe("part.stl");
  });

  it("never includes raw output bytes in the report", () => {
    const job = { ...makeJob(), state: "succeeded" as const, outputBytes: new ArrayBuffer(1024) };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "generated");
    expect(JSON.stringify(report)).not.toMatch(/ArrayBuffer/);
    expect((report.files[0] as unknown as Record<string, unknown>).outputBytes).toBeUndefined();
  });

  it("never includes a stack trace even if one somehow ended up on the job's error", () => {
    const job = {
      ...makeJob(),
      state: "failed" as const,
      error: { code: "UNKNOWN_ERROR", message: "boom\n    at Object.<anonymous> (/some/path.ts:12:5)", recoverable: false } satisfies SafeError,
    };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "not-generated");
    expect(JSON.stringify(report)).not.toContain("at Object.<anonymous>");
  });

  it("includes standing limitations text", () => {
    const report = buildDownloadableBatchReport([], "repair-stl", {}, "not-generated");
    expect(report.limitations.length).toBeGreaterThan(0);
  });
});

describe("buildDownloadableBatchReport — Phase 10 hotfix: Stage 4 defense-in-depth guard on resultMeta", () => {
  it("never throws — even when a job's resultMeta contains raw geometry arrays (the original crash reproduction)", () => {
    const job = {
      ...makeJob({ operationId: "convert-obj-to-stl" }),
      state: "succeeded" as const,
      outputBytes: new ArrayBuffer(512),
      resultMeta: { positions: new Float32Array(2_000_000), normals: new Float32Array(2_000_000), triangleCount: 200_000 },
    };
    expect(() => {
      const report = buildDownloadableBatchReport([job], "convert-obj-to-stl", {}, "generated");
      JSON.stringify(report);
    }).not.toThrow();
  });

  it("a job whose resultMeta fails the safety guard gets a small safe placeholder in the report — never the raw unsafe value", () => {
    const job = {
      ...makeJob({ operationId: "convert-obj-to-stl" }),
      state: "succeeded" as const,
      outputBytes: new ArrayBuffer(512),
      resultMeta: { positions: new Float32Array(1024) },
    };
    const report = buildDownloadableBatchReport([job], "convert-obj-to-stl", {}, "generated");
    expect(JSON.stringify(report.files[0].resultMeta)).not.toContain("positions");
  });

  it("valid, already-safe conversion resultMeta passes through completely unchanged", () => {
    const meta = { triangleCount: 12, sourceVertexCount: 8, bounds: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] }, warnings: [] };
    const job = { ...makeJob({ operationId: "convert-obj-to-stl" }), state: "succeeded" as const, outputBytes: new ArrayBuffer(512), resultMeta: meta };
    const report = buildDownloadableBatchReport([job], "convert-obj-to-stl", {}, "generated");
    expect(report.files[0].resultMeta).toEqual(meta);
  });

  it("REGRESSION (Stage 6): repair's own resultMeta shape is completely unaffected — every diagnostic field survives untouched", () => {
    const meta = {
      outcome: "fully-repaired",
      before: { verdict: "not-watertight", triangleCount: 10, boundaryEdgeCount: 4 },
      after: { verdict: "watertight", triangleCount: 12, boundaryEdgeCount: 0 },
      warnings: [],
    };
    const job = { ...makeJob({ operationId: "repair-stl" }), state: "succeeded" as const, outputBytes: new ArrayBuffer(512), resultMeta: meta };
    const report = buildDownloadableBatchReport([job], "repair-stl", {}, "generated");
    expect(report.files[0].resultMeta).toEqual(meta);
  });

  it("REGRESSION (Stage 6): optimize's own resultMeta shape is completely unaffected — deviation/surface-area/volume/timing fields survive untouched", () => {
    const meta = {
      outcome: "target-achieved",
      deviation: { maxDeviation: 0.01, meanDeviation: 0.002, sampleCount: 4000 },
      surfaceAreaBefore: 12.4,
      surfaceAreaAfter: 12.3,
      volumeBefore: 4.1,
      volumeAfter: 4.08,
      stageTimings: [{ stage: "simplifying-mesh", durationMs: 78 }],
    };
    const job = { ...makeJob({ operationId: "optimize-stl" }), state: "succeeded" as const, outputBytes: new ArrayBuffer(512), resultMeta: meta };
    const report = buildDownloadableBatchReport([job], "optimize-stl", {}, "generated");
    expect(report.files[0].resultMeta).toEqual(meta);
  });
});
