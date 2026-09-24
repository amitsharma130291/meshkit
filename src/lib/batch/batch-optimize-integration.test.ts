/**
 * End-to-end batch-optimization tests using the REAL production
 * pipeline — `parseSTL()` → `optimizeSTL()` → `adapter-registry.ts`'s
 * own `unwrapOptimizeResult()` — driven through the real `BatchQueue` +
 * `BatchScheduler`. Same testing boundary as
 * `batch-repair-integration.test.ts`: only the Worker transport is
 * replaced (Node has no `Worker`), never the optimization algorithm
 * itself.
 */
import { describe, expect, it } from "vitest";
import { CancellationRequested } from "../cancellation";
import { createSafeError } from "../errors";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { optimizeSTL } from "../mesh-optimization/optimize";
import { toSTLOptimizeSafeError } from "../mesh-optimization/errors";
import { DEFAULT_OPTIMIZE_LIMITS, defaultOptimizeSettings, type OptimizeSettings } from "../mesh-optimization/types";
import { smoothSphere, subdividedPlane, twoDistinctShells } from "../mesh-optimization/test-fixtures";
import { threeTrianglesSharingOneEdge } from "../stl-diagnostics/test-fixtures";
import { unwrapOptimizeResult } from "./adapter-registry";
import { BatchQueue } from "./queue-state";
import { BatchScheduler, type JobRunContext, type JobRunOutcome, type JobRunner } from "./scheduler";
import type { BatchJob } from "./types";

function stlFile(positions: Float32Array, name: string): File {
  return new File([serializeBinarySTL({ positions })], name, { type: "model/stl" });
}

function invalidStlFile(name: string): File {
  const bytes = new Uint8Array(80 + 4 + 10);
  new DataView(bytes.buffer).setUint32(80, 5, true); // claims 5 triangles, far fewer bytes present
  return new File([bytes], name, { type: "model/stl" });
}

function createDirectOptimizeJobRunner(): JobRunner {
  return {
    async run(job: BatchJob, context: JobRunContext): Promise<JobRunOutcome> {
      try {
        const buffer = await job.file.arrayBuffer();
        const parsed = parseSTL(buffer, DEFAULT_STL_LIMITS);
        const settings = job.settings as OptimizeSettings;
        const result = await optimizeSTL(parsed.positions, settings, DEFAULT_OPTIMIZE_LIMITS, {
          isCancelled: context.isCancelled,
          onProgress: (stage) => {
            if (stage === "verifying-optimized-stl") context.enterState("verifying");
            context.onProgress(stage, 0);
          },
        });
        const unwrapped = unwrapOptimizeResult({ mode: "optimize", optimize: result });
        if (!unwrapped) return { ok: false, error: createSafeError("STLOPT_VERIFICATION_FAILED") };
        return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
      } catch (error) {
        if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
        return { ok: false, error: toSTLOptimizeSafeError(error) };
      }
    },
  };
}

async function runToCompletion(queue: BatchQueue, scheduler: BatchScheduler, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  scheduler.start();
  while (queue.getJobs().some((j) => j.state !== "succeeded" && j.state !== "failed" && j.state !== "cancelled")) {
    if (Date.now() - start > timeoutMs) throw new Error("runToCompletion timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Batch optimization — real production pipeline, outcome coverage", () => {
  it("target achieved: a comfortable reduction on a smooth sphere", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    const settings: OptimizeSettings = { target: { mode: "triangle-count", value: 300 }, preset: "balanced" };
    queue.addFile({ file: stlFile(smoothSphere(14, 28), "sphere.stl"), displayName: "sphere.stl", operationId: "optimize-stl", settings });
    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    expect(job.state).toBe("succeeded");
    expect((job.resultMeta as { outcome: string }).outcome).toBe("target-achieved");
    expect(job.outputBytes).not.toBeNull();
  });

  it("no safe collapses: non-manifold input is classified unsafe, never mutated, and correctly surfaces as a batch FAILURE (no output bytes exist to download)", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({
      file: stlFile(threeTrianglesSharingOneEdge(), "nonmanifold.stl"),
      displayName: "nonmanifold.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "triangle-count", value: 1 }, preset: "balanced" },
    });
    await runToCompletion(queue, scheduler);

    // optimizeSTL itself returns early for unsafe-to-simplify eligibility
    // with outputBytes: null — no mutation is ever attempted. A batch job
    // with no output bytes is correctly a FAILURE, not a silent success.
    const job = queue.getJobs()[0];
    expect(job.state).toBe("failed");
    expect(job.outputBytes).toBeNull();
  });

  it("threshold verification failure: extreme reduction under a tight preset is never counted as a successful batch output", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({
      file: stlFile(smoothSphere(14, 28), "sphere.stl"),
      displayName: "sphere.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "triangle-count", value: 8 }, preset: "preserve-details", minTrianglesPerShell: 4 },
    });
    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    // The unwrap function rejects verification-failed even though real
    // output bytes were produced — this must surface as a FAILED batch
    // job, never a false "succeeded."
    expect(job.state).toBe("failed");
    expect(job.outputBytes).toBeNull();
  });

  it("open mesh: boundary-preserving reduction still succeeds", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({
      file: stlFile(subdividedPlane(6), "plane.stl"),
      displayName: "plane.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "percentage", value: 50 }, preset: "balanced" },
    });
    await runToCompletion(queue, scheduler);
    expect(queue.getJobs()[0].state).toBe("succeeded");
  });

  it("multiple shells: shell count is preserved and reported in the batch result", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({
      file: stlFile(twoDistinctShells(), "shells.stl"),
      displayName: "shells.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "percentage", value: 70 }, preset: "balanced" },
    });
    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    expect(job.state).toBe("succeeded");
    const meta = job.resultMeta as { shellCountBefore: number | null; shellCountAfter: number | null };
    expect(meta.shellCountAfter).toBe(meta.shellCountBefore);
  });

  it("invalid STL fails at the parse step, before optimization ever runs", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({ file: invalidStlFile("bad.stl"), displayName: "bad.stl", operationId: "optimize-stl", settings: defaultOptimizeSettings() });
    await runToCompletion(queue, scheduler);
    expect(queue.getJobs()[0].state).toBe("failed");
  });

  it("cancellation produces no output, even though optimizeSTL itself throws rather than resolving", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    const job = queue.addFile({
      file: stlFile(smoothSphere(14, 28), "sphere.stl"),
      displayName: "sphere.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "triangle-count", value: 8 }, preset: "balanced" },
    })!;
    scheduler.start();
    queue.cancel(job.id);
    await runToCompletion(queue, scheduler);

    const finalJob = queue.getJob(job.id)!;
    expect(finalJob.state).toBe("cancelled");
    expect(finalJob.outputBytes).toBeNull();
  });

  it("a successful result's output size, deviation, surface-area and volume comparisons are all real and retained", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectOptimizeJobRunner());
    queue.addFile({
      file: stlFile(smoothSphere(14, 28), "sphere.stl"),
      displayName: "sphere.stl",
      operationId: "optimize-stl",
      settings: { target: { mode: "triangle-count", value: 300 }, preset: "balanced" },
    });
    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    expect(job.outputBytes).not.toBeNull();
    expect(job.outputBytes!.byteLength).toBeGreaterThan(0);

    const reopened = parseSTL(job.outputBytes!, DEFAULT_STL_LIMITS);
    expect(reopened.triangleCount).toBeGreaterThan(0);

    const meta = job.resultMeta as {
      deviation: { completed: boolean } | null;
      surfaceAreaBefore: number;
      surfaceAreaAfter: number | null;
      volumeBefore: number | null;
      volumeAfter: number | null;
      thresholdCheck: { exceededSurfaceAreaThreshold: boolean; exceededVolumeThreshold: boolean };
      shellCountBefore: number | null;
      optimizedTriangleCount: number;
    };
    expect(meta.deviation?.completed).toBe(true);
    expect(meta.surfaceAreaAfter).not.toBeNull();
    expect(meta.thresholdCheck.exceededSurfaceAreaThreshold).toBe(false);
    expect(meta.thresholdCheck.exceededVolumeThreshold).toBe(false);
    expect(meta.shellCountBefore).toBe(1);
    expect(meta.optimizedTriangleCount).toBeGreaterThan(0);
  });

  it("output filenames stay deterministic across repeated batch runs of the same source file", async () => {
    const { buildOutputFilename, FilenameCollisionTracker } = await import("./filenames");
    const tracker1 = new FilenameCollisionTracker();
    const tracker2 = new FilenameCollisionTracker();
    expect(buildOutputFilename("sphere.stl", "stl", tracker1)).toBe(buildOutputFilename("sphere.stl", "stl", tracker2));
  });
});
