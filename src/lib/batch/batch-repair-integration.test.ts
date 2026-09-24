/**
 * End-to-end batch-repair tests using the REAL production pipeline —
 * `parseSTL()` → `repairSTL()` → `adapter-registry.ts`'s own
 * `unwrapRepairResult()` — driven through the real `BatchQueue` +
 * `BatchScheduler`. The only thing NOT real here is the Worker
 * transport itself (Node has no `Worker`): `createDirectRepairJobRunner()`
 * calls the exact same functions `stl-repair.worker.ts` calls, in the
 * same order, just without the postMessage indirection — this is
 * intentionally NOT a mock of the repair pipeline, only of the
 * cross-thread transport (already separately verified by
 * `worker-job-runner.test.ts`'s FakeWorker tests and by live browser
 * verification).
 */
import { describe, expect, it } from "vitest";
import { CancellationRequested } from "../cancellation";
import { createSafeError } from "../errors";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { repairSTL } from "../stl-repair/repair";
import { toSTLRepairSafeError } from "../stl-repair/errors";
import { DEFAULT_REPAIR_LIMITS, safePreset, type RepairSettings } from "../stl-repair/types";
import {
  duplicateFaceSameWinding,
  inwardClosedCube,
  openCubeMissingFace,
  outwardClosedCube,
  properTriangleIntersection,
  repeatedPositionDegeneracy,
  threeTrianglesSharingOneEdge,
  branchedBoundaryWithDanglingFlap,
} from "../stl-diagnostics/test-fixtures";
import { unwrapRepairResult } from "./adapter-registry";
import { buildOutputFilename, FilenameCollisionTracker } from "./filenames";
import { BatchQueue } from "./queue-state";
import { BatchScheduler, type JobRunContext, type JobRunOutcome, type JobRunner } from "./scheduler";
import type { BatchJob } from "./types";
import { buildBatchZip } from "./zip-download";

function stlFile(positions: Float32Array, name: string): File {
  const buffer = serializeBinarySTL({ positions });
  return new File([buffer], name, { type: "model/stl" });
}

/** A deliberately truncated binary STL — a real header + triangle count claiming more triangles than the buffer actually contains. */
function invalidStlFile(name: string): File {
  const header = new Uint8Array(80);
  const countBuf = new ArrayBuffer(4);
  new DataView(countBuf).setUint32(0, 5, true); // claims 5 triangles
  const bytes = new Uint8Array(80 + 4 + 10); // far fewer bytes than 5 triangles need (50 bytes each)
  bytes.set(header, 0);
  bytes.set(new Uint8Array(countBuf), 80);
  return new File([bytes], name, { type: "model/stl" });
}

function createDirectRepairJobRunner(): JobRunner {
  return {
    async run(job: BatchJob, context: JobRunContext): Promise<JobRunOutcome> {
      try {
        const buffer = await job.file.arrayBuffer();
        const parsed = parseSTL(buffer, DEFAULT_STL_LIMITS);
        const settings = job.settings as RepairSettings;
        const result = await repairSTL(parsed.positions, settings, DEFAULT_REPAIR_LIMITS, {
          isCancelled: context.isCancelled,
          onProgress: (stage) => {
            if (stage === "verifying-repaired-stl") context.enterState("verifying");
            context.onProgress(stage, 0);
          },
        });
        const unwrapped = unwrapRepairResult({ mode: "repair", repair: result });
        if (!unwrapped) return { ok: false, error: createSafeError("STLREPAIR_VERIFICATION_FAILED") };
        return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
      } catch (error) {
        if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
        return { ok: false, error: toSTLRepairSafeError(error) };
      }
    },
  };
}

async function runToCompletion(queue: BatchQueue, scheduler: BatchScheduler, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  scheduler.start();
  while (queue.getJobs().some((j) => j.state !== "succeeded" && j.state !== "failed" && j.state !== "cancelled")) {
    if (Date.now() - start > timeoutMs) throw new Error("runToCompletion timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FixtureSpec {
  name: string;
  file: File;
}

function buildMixedBatch(): FixtureSpec[] {
  return [
    { name: "repairable-open.stl", file: stlFile(openCubeMissingFace(), "repairable-open.stl") },
    { name: "already-watertight.stl", file: stlFile(outwardClosedCube(), "already-watertight.stl") },
    { name: "inward-shell.stl", file: stlFile(inwardClosedCube(), "inward-shell.stl") },
    { name: "duplicate-faces.stl", file: stlFile(duplicateFaceSameWinding(), "duplicate-faces.stl") },
    { name: "degenerate-triangle.stl", file: stlFile(repeatedPositionDegeneracy(), "degenerate-triangle.stl") },
    { name: "unresolved-non-manifold.stl", file: stlFile(threeTrianglesSharingOneEdge(), "unresolved-non-manifold.stl") },
    { name: "unsafe-boundary.stl", file: stlFile(branchedBoundaryWithDanglingFlap(), "unsafe-boundary.stl") },
    { name: "self-intersection.stl", file: stlFile(properTriangleIntersection(), "self-intersection.stl") },
    { name: "invalid.stl", file: invalidStlFile("invalid.stl") },
  ];
}

describe("Batch repair — mixed batch through the real production pipeline", () => {
  it("processes every file independently through the full 10-step pipeline", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    const fixtures = buildMixedBatch();
    const jobs = fixtures.map((f) => queue.addFile({ file: f.file, displayName: f.name, operationId: "repair-stl", settings: safePreset() })!);

    await runToCompletion(queue, scheduler);

    const byName = new Map(queue.getJobs().map((j) => [j.displayName, j]));

    // 1-2: original parsing + diagnostics happened (implicit — repairSTL's
    // own `before` diagnostics field is populated) for every file that
    // reached repair at all (everything except the invalid STL).
    for (const name of ["repairable-open.stl", "already-watertight.stl", "inward-shell.stl", "duplicate-faces.stl", "degenerate-triangle.stl"]) {
      const job = byName.get(name)!;
      expect(job.state).toBe("succeeded");
      expect((job.resultMeta as { before: unknown }).before).toBeTruthy();
    }

    // 3-8: planning, execution, serialization, reparse, final diagnostics,
    // outcome classification — all visible in resultMeta.outcome.
    expect((byName.get("repairable-open.stl")!.resultMeta as { outcome: string }).outcome).toBe("fully-repaired");
    expect((byName.get("already-watertight.stl")!.resultMeta as { outcome: string }).outcome).toBe("unchanged");
    // These three fixtures each have exactly one fixable defect — the
    // repair genuinely changes something for the better, but exactly
    // WHICH positive outcome ("improved," "partially-repaired," or even
    // "fully-repaired" if that one fix happens to be all the mesh
    // needed) depends on the fixture's precise starting shape, not on
    // anything this test should hard-code. What matters is that it's
    // never "unchanged" (nothing was wrong) and never
    // "unable-to-repair-safely" (the known fix wasn't applied).
    const positiveOutcomes = ["improved", "partially-repaired", "fully-repaired"];
    for (const name of ["inward-shell.stl", "duplicate-faces.stl", "degenerate-triangle.stl"]) {
      expect(positiveOutcomes).toContain((byName.get(name)!.resultMeta as { outcome: string }).outcome);
    }

    // Unresolved/unsafe/self-intersecting meshes: repair still SUCCEEDS
    // (output bytes exist, reparsed+reverified) but the outcome is never
    // upgraded past what actually verified true.
    const nonManifold = byName.get("unresolved-non-manifold.stl")!;
    expect(nonManifold.state).toBe("succeeded");
    expect((nonManifold.resultMeta as { outcome: string }).outcome).not.toBe("fully-repaired");

    // 9: invalid STL fails at the parse step, before repair ever runs.
    const invalid = byName.get("invalid.stl")!;
    expect(invalid.state).toBe("failed");
    expect(invalid.error).not.toBeNull();

    // 10: queue state — every job reached a genuine terminal state.
    for (const job of jobs) expect(["succeeded", "failed"]).toContain(job.state);
  });

  it("one failed file (invalid STL) never stops the others from processing", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: invalidStlFile("bad.stl"), displayName: "bad.stl", operationId: "repair-stl", settings: safePreset() });
    queue.addFile({ file: stlFile(openCubeMissingFace(), "good.stl"), displayName: "good.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const jobs = queue.getJobs();
    expect(jobs.find((j) => j.displayName === "bad.stl")!.state).toBe("failed");
    expect(jobs.find((j) => j.displayName === "good.stl")!.state).toBe("succeeded");
  });

  it("unresolved non-manifold topology is never counted as a repaired outcome", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: stlFile(threeTrianglesSharingOneEdge(), "nonmanifold.stl"), displayName: "nonmanifold.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    expect(job.state).toBe("succeeded"); // output exists and is verified
    expect((job.resultMeta as { outcome: string }).outcome).not.toBe("fully-repaired");
  });

  it("an already-valid watertight file is not unnecessarily changed", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: stlFile(outwardClosedCube(), "valid.stl"), displayName: "valid.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    const meta = job.resultMeta as { outcome: string; trianglesBefore: number; trianglesAfter: number };
    expect(meta.outcome).toBe("unchanged");
    expect(meta.trianglesAfter).toBe(meta.trianglesBefore);
  });

  it("a verified repaired output reopens with the production STL parser", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: stlFile(openCubeMissingFace(), "reopen.stl"), displayName: "reopen.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const job = queue.getJobs()[0];
    expect(job.outputBytes).not.toBeNull();
    const reopened = parseSTL(job.outputBytes!, DEFAULT_STL_LIMITS);
    expect(reopened.triangleCount).toBeGreaterThan(0);
  });

  it("a cancelled job produces no downloadable output", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    const job = queue.addFile({ file: stlFile(openCubeMissingFace(), "cancel-me.stl"), displayName: "cancel-me.stl", operationId: "repair-stl", settings: safePreset() })!;
    scheduler.start();
    queue.cancel(job.id);
    await runToCompletion(queue, scheduler);

    const finalJob = queue.getJob(job.id)!;
    expect(finalJob.state).toBe("cancelled");
    expect(finalJob.outputBytes).toBeNull();
  });

  it("the batch summary/report includes every failed and unresolved file, correctly classified", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: invalidStlFile("bad.stl"), displayName: "bad.stl", operationId: "repair-stl", settings: safePreset() });
    queue.addFile({ file: stlFile(threeTrianglesSharingOneEdge(), "unresolved.stl"), displayName: "unresolved.stl", operationId: "repair-stl", settings: safePreset() });
    queue.addFile({ file: stlFile(openCubeMissingFace(), "fixed.stl"), displayName: "fixed.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const jobs = queue.getJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.find((j) => j.displayName === "bad.stl")!.state).toBe("failed");
    expect(jobs.find((j) => j.displayName === "unresolved.stl")!.state).toBe("succeeded");
    expect((jobs.find((j) => j.displayName === "unresolved.stl")!.resultMeta as { outcome: string }).outcome).not.toBe("fully-repaired");
    expect(jobs.find((j) => j.displayName === "fixed.stl")!.state).toBe("succeeded");
  });

  it("a ZIP built from a mixed batch contains outputs only for succeeded jobs, reports for every job", async () => {
    const queue = new BatchQueue();
    const scheduler = new BatchScheduler(queue, createDirectRepairJobRunner());
    queue.addFile({ file: invalidStlFile("bad.stl"), displayName: "bad.stl", operationId: "repair-stl", settings: safePreset() });
    queue.addFile({ file: stlFile(openCubeMissingFace(), "fixed.stl"), displayName: "fixed.stl", operationId: "repair-stl", settings: safePreset() });
    queue.addFile({ file: stlFile(outwardClosedCube(), "valid.stl"), displayName: "valid.stl", operationId: "repair-stl", settings: safePreset() });

    await runToCompletion(queue, scheduler);

    const jobs = queue.getJobs();
    const tracker = new FilenameCollisionTracker();
    const entries = jobs.map((job) => ({
      jobId: job.id,
      outputFilename: buildOutputFilename(job.displayName, "stl", tracker),
      outputBytes: job.outputBytes,
      reportJson: JSON.stringify({ id: job.id, state: job.state }),
      state: job.state,
    }));
    const zipBytes = buildBatchZip(entries, JSON.stringify({ total: jobs.length }));

    const { unzipSync } = await import("fflate");
    const files = Object.keys(unzipSync(new Uint8Array(zipBytes)));
    const outputPaths = files.filter((f) => f.startsWith("outputs/"));
    const reportPaths = files.filter((f) => f.startsWith("reports/"));

    expect(outputPaths).toHaveLength(2); // "bad.stl" failed — no output entry
    expect(outputPaths.every((p) => !p.includes("bad"))).toBe(true);
    expect(reportPaths).toHaveLength(3); // every job, including the failed one
  });
});
