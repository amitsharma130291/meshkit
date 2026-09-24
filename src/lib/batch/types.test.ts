import { describe, expect, it } from "vitest";
import { BATCH_JOB_STATES, createBatchJob } from "./types";

function makeFile(name = "part.stl", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "model/stl" });
}

describe("BATCH_JOB_STATES — the exhaustive job-state list", () => {
  it("contains exactly the seven documented states, in the documented order", () => {
    expect(BATCH_JOB_STATES).toEqual(["queued", "validating", "processing", "verifying", "succeeded", "failed", "cancelled"]);
  });
});

describe("createBatchJob", () => {
  it("starts in the queued state with sane defaults", () => {
    const job = createBatchJob({ file: makeFile(), displayName: "part.stl", operationId: "repair-stl", settings: { preset: "safe" } });
    expect(job.state).toBe("queued");
    expect(job.progressStage).toBeNull();
    expect(job.progressValue).toBe(0);
    expect(job.resultMeta).toBeNull();
    expect(job.outputBytes).toBeNull();
    expect(job.error).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.retryCount).toBe(0);
    expect(job.cancellationGeneration).toBe(0);
  });

  it("captures the source file's size and the given display name/operation/settings", () => {
    const job = createBatchJob({ file: makeFile("model.stl", 2048), displayName: "model.stl", operationId: "optimize-stl", settings: { target: { mode: "percentage", value: 50 } } });
    expect(job.sourceSize).toBe(2048);
    expect(job.displayName).toBe("model.stl");
    expect(job.operationId).toBe("optimize-stl");
    expect(job.settings).toEqual({ target: { mode: "percentage", value: 50 } });
  });

  it("assigns a stable, unique internal id to every job", () => {
    const a = createBatchJob({ file: makeFile(), displayName: "a.stl", operationId: "repair-stl", settings: {} });
    const b = createBatchJob({ file: makeFile(), displayName: "a.stl", operationId: "repair-stl", settings: {} });
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("records a createdAt timestamp", () => {
    const before = Date.now();
    const job = createBatchJob({ file: makeFile(), displayName: "a.stl", operationId: "repair-stl", settings: {} });
    expect(job.createdAt).toBeGreaterThanOrEqual(before);
  });
});
