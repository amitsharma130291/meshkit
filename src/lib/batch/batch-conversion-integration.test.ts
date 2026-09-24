/**
 * Phase 10 hotfix — Stage 5: end-to-end batch-conversion tests using the
 * REAL production pipeline for all six conversion operations, through
 * the real `BatchQueue` + `BatchScheduler` + `adapter-registry.ts`'s own
 * `unwrapConversionResult()` (now explicitly projected, per the hotfix).
 * Mirrors `batch-repair-integration.test.ts`'s own pattern: only the
 * Worker transport is replaced by a same-thread "direct job runner"
 * calling the exact functions each conversion worker calls, in the same
 * order — never a mock of the conversion pipeline itself.
 *
 * Every family is run through the identical 12-point checklist Stage 5
 * specifies: succeeds, individual output available and reparses, JSON
 * report downloads, ZIP downloads, ZIP contains the output + per-file
 * report + batch-summary.json, report has useful metadata and NO raw
 * geometry, invalid jobs stay isolated, only successful jobs appear in
 * the ZIP's `outputs/`.
 */
import { describe, expect, it } from "vitest";
import { decodeOBJText } from "../obj/tokenizer";
import { parseOBJDocument } from "../obj/parser";
import { buildOBJGeometry } from "../obj/convert";
import { DEFAULT_OBJ_LIMITS } from "../obj/types";
import { toOBJSafeError } from "../obj/errors";
import { openThreeMFPackage } from "../threemf/package";
import { findPrimaryModelPath } from "../threemf/relationships";
import { parseThreeMFModel } from "../threemf/model-parser";
import { resolveScene } from "../threemf/resolve-scene";
import { DEFAULT_THREEMF_LIMITS } from "../threemf/types";
import { toThreeMFSafeError } from "../threemf/errors";
import { simpleTriangleMesh, buildModelXML, build3MFPackage } from "../threemf/test-fixtures";
import { parseGLB } from "../glb/convert";
import { decodeMeshes } from "../glb/primitives";
import { resolveGLBScene } from "../glb/resolve-scene";
import { DEFAULT_GLB_LIMITS } from "../glb/types";
import { toGLBSafeError } from "../glb/errors";
import { simpleTriangleGLB } from "../glb/test-fixtures";
import { resolvePLYSchema, readPLYBody } from "../ply/parser";
import { buildPLYGeometry } from "../ply/convert";
import { DEFAULT_PLY_LIMITS } from "../ply/types";
import { toPLYSafeError } from "../ply/errors";
import { simpleTrianglePLY } from "../ply/test-fixtures";
import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { filterDegenerateTriangles as filterDegenerateForObj } from "../stl-to-obj/convert";
import { deduplicateStep as dedupeForObj, serializeStep as serializeForObj, extractFaceNormals } from "../stl-to-obj/convert";
import { DEFAULT_STL_TO_OBJ_LIMITS } from "../stl-to-obj/types";
import { toSTLToOBJSafeError } from "../stl-to-obj/errors";
import { filterDegenerateTriangles as filterDegenerateFor3mf } from "../stl/degenerate";
import { deduplicateStep as dedupeFor3mf, verifyPackageOutput } from "../stl-to-threemf/convert";
import { writeModelXML } from "../threemf/model-writer";
import { writeThreeMFPackage } from "../threemf/package-writer";
import { DEFAULT_STL_TO_THREEMF_LIMITS } from "../stl-to-threemf/types";
import { toSTLToThreeMFSafeError } from "../stl-to-threemf/errors";
import { CancellationRequested } from "../cancellation";
import { createSafeError } from "../errors";
import { unwrapConversionResult } from "./adapter-registry";
import { projectGlbToStlMeta, projectObjToStlMeta, projectPlyToStlMeta, projectStlToObjMeta, projectStlToThreeMFMeta, projectThreeMFToStlMeta } from "./conversion-result-meta";
import { buildDownloadableBatchReport } from "./report";
import { BatchQueue } from "./queue-state";
import { BatchScheduler, type JobRunContext, type JobRunOutcome, type JobRunner } from "./scheduler";
import type { BatchJob, BatchOperationId } from "./types";
import { buildOutputFilename, FilenameCollisionTracker } from "./filenames";
import { buildBatchZip } from "./zip-download";

async function runToCompletion(queue: BatchQueue, scheduler: BatchScheduler, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  scheduler.start();
  while (queue.getJobs().some((j) => j.state !== "succeeded" && j.state !== "failed" && j.state !== "cancelled")) {
    if (Date.now() - start > timeoutMs) throw new Error("runToCompletion timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function directRunner(run: (job: BatchJob, context: JobRunContext) => Promise<JobRunOutcome>): JobRunner {
  return { run };
}

// --- Direct job runners: same functions each worker calls, same order, no postMessage indirection ---

function createDirectObjToStlRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const text = decodeOBJText(buffer, DEFAULT_OBJ_LIMITS);
      const doc = parseOBJDocument(text, DEFAULT_OBJ_LIMITS);
      const parsed = buildOBJGeometry(doc, DEFAULT_OBJ_LIMITS);
      const stlBuffer = serializeBinarySTL({ positions: parsed.positions, normals: parsed.normals, header: "MeshWrench OBJ to STL conversion" });
      const raw = { ...parsed, stlBuffer };
      const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectObjToStlMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toOBJSafeError(error) };
    }
  });
}

function createDirectThreeMFToStlRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const pkg = openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS);
      const modelPath = findPrimaryModelPath(pkg);
      const modelBytes = pkg.readEntry(modelPath);
      const xml = new TextDecoder("utf-8", { fatal: false }).decode(modelBytes);
      const model = parseThreeMFModel(xml, DEFAULT_THREEMF_LIMITS);
      const scene = resolveScene(model, DEFAULT_THREEMF_LIMITS);
      const stlBuffer = serializeBinarySTL({ positions: scene.positions, normals: scene.normals, header: "MeshWrench 3MF to STL conversion" });
      const raw = { ...scene, stlBuffer, sourceUnit: model.unit, outputScale: "millimeter" };
      const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectThreeMFToStlMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toThreeMFSafeError(error) };
    }
  });
}

function createDirectGlbToStlRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const { doc, bin } = parseGLB(buffer, DEFAULT_GLB_LIMITS);
      const { meshes, skippedUnsupportedPrimitiveCount } = decodeMeshes(doc, bin, DEFAULT_GLB_LIMITS);
      const scene = resolveGLBScene(doc, meshes, DEFAULT_GLB_LIMITS, skippedUnsupportedPrimitiveCount);
      const stlBuffer = serializeBinarySTL({ positions: scene.positions, normals: scene.normals, header: "MeshWrench GLB to STL conversion" });
      const raw = { ...scene, stlBuffer, sourceUnits: "meter", outputScale: "millimeter", scaleFactor: 1000 };
      const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectGlbToStlMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toGLBSafeError(error) };
    }
  });
}

function createDirectPlyToStlRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const schema = resolvePLYSchema(buffer, DEFAULT_PLY_LIMITS);
      const doc = readPLYBody(schema, buffer, DEFAULT_PLY_LIMITS);
      const parsed = buildPLYGeometry(doc, DEFAULT_PLY_LIMITS);
      const stlBuffer = serializeBinarySTL({ positions: parsed.positions, normals: parsed.normals, header: "MeshWrench PLY to STL conversion" });
      const raw = { ...parsed, stlBuffer };
      const unwrapped = unwrapConversionResult(raw, "stlBuffer", projectPlyToStlMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toPLYSafeError(error) };
    }
  });
}

function createDirectStlToObjRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const parsed = parseSTL(buffer, DEFAULT_STL_TO_OBJ_LIMITS.stl);
      const filtered = filterDegenerateForObj(parsed);
      const isCancelled = () => false;
      const geometry = await dedupeForObj(filtered.positions, DEFAULT_STL_TO_OBJ_LIMITS.dedup, { isCancelled });
      const faceNormals = extractFaceNormals(filtered.normals);
      const serialized = await serializeForObj(geometry, faceNormals, DEFAULT_STL_TO_OBJ_LIMITS.serialize, { isCancelled, onStage: () => undefined });
      const objBuffer = serialized.bytes.buffer as ArrayBuffer;
      const raw = {
        positions: filtered.positions,
        normals: filtered.normals,
        objBuffer,
        inputEncoding: parsed.encoding,
        inputTriangleCount: parsed.triangleCount,
        outputFaceCount: serialized.faceCount,
        sourceTriangleVertexCount: geometry.sourceVertexCount,
        uniqueVertexCount: geometry.uniqueVertexCount,
        duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
        skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
        outputByteLength: serialized.outputByteLength,
        bounds: filtered.bounds,
        warnings: [],
      };
      const unwrapped = unwrapConversionResult(raw, "objBuffer", projectStlToObjMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toSTLToOBJSafeError(error) };
    }
  });
}

function createDirectStlToThreeMFRunner(): JobRunner {
  return directRunner(async (job) => {
    try {
      const buffer = await job.file.arrayBuffer();
      const parsed = parseSTL(buffer, DEFAULT_STL_TO_THREEMF_LIMITS.stl);
      const filtered = filterDegenerateFor3mf(parsed);
      const isCancelled = () => false;
      const geometry = await dedupeFor3mf(filtered.positions, DEFAULT_STL_TO_THREEMF_LIMITS.dedup, { isCancelled });
      const modelXML = await writeModelXML(geometry, DEFAULT_STL_TO_THREEMF_LIMITS.model, { isCancelled });
      const threeMFBuffer = writeThreeMFPackage(modelXML, DEFAULT_STL_TO_THREEMF_LIMITS.package);
      verifyPackageOutput(threeMFBuffer, modelXML.length, DEFAULT_STL_TO_THREEMF_LIMITS.package);
      const outputTriangleCount = geometry.triangleVertexIndices.length / 3;
      const raw = {
        positions: filtered.positions,
        normals: filtered.normals,
        threeMFBuffer,
        inputEncoding: parsed.encoding,
        inputTriangleCount: parsed.triangleCount,
        outputTriangleCount,
        sourceTriangleVertexCount: geometry.sourceVertexCount,
        uniqueVertexCount: geometry.uniqueVertexCount,
        duplicateVertexReferencesRemoved: geometry.sourceVertexCount - geometry.uniqueVertexCount,
        skippedDegenerateTriangles: filtered.skippedDegenerateTriangles,
        declaredUnit: "millimeter",
        coordinateScale: 1,
        outputByteLength: threeMFBuffer.byteLength,
        bounds: filtered.bounds,
        warnings: [],
      };
      const unwrapped = unwrapConversionResult(raw, "threeMFBuffer", projectStlToThreeMFMeta);
      if (!unwrapped) return { ok: false, error: createSafeError("UNKNOWN_ERROR") };
      return { ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes };
    } catch (error) {
      if (error instanceof CancellationRequested) return { ok: false, error: createSafeError("PROCESS_CANCELLED") };
      return { ok: false, error: toSTLToThreeMFSafeError(error) };
    }
  });
}

// --- Fixtures ---

function stlPositions(): Float32Array {
  // A single, non-degenerate triangle.
  return new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
}

function objFile(name = "tri.obj"): File {
  return new File(["v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n"], name, { type: "model/obj" });
}
function invalidObjFile(name = "bad.obj"): File {
  return new File(["this is not a valid obj @#$%"], name, { type: "model/obj" });
}

function threeMFFile(name = "tri.3mf"): File {
  const xml = buildModelXML({ objects: [simpleTriangleMesh()], buildItems: [{ objectId: "1" }] });
  return new File([build3MFPackage(xml)], name, { type: "model/3mf" });
}
function invalidThreeMFFile(name = "bad.3mf"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "model/3mf" });
}

function glbFile(name = "tri.glb"): File {
  return new File([simpleTriangleGLB()], name, { type: "model/gltf-binary" });
}
function invalidGlbFile(name = "bad.glb"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "model/gltf-binary" });
}

function plyFile(name = "tri.ply"): File {
  return new File([simpleTrianglePLY("ascii")], name, { type: "model/ply" });
}
function invalidPlyFile(name = "bad.ply"): File {
  return new File(["not a ply file"], name, { type: "model/ply" });
}

function stlFile(name = "tri.stl"): File {
  return new File([serializeBinarySTL({ positions: stlPositions() })], name, { type: "model/stl" });
}
function invalidStlFile(name = "bad.stl"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "model/stl" });
}

interface ConversionFamilySpec {
  operationId: BatchOperationId;
  outputExtension: string;
  validFile: () => File;
  invalidFile: () => File;
  createRunner: () => JobRunner;
  /** Reparses the produced output with the REAL production parser for that output format, returning a triangle count (or equivalent) to prove the bytes are genuinely usable. */
  reparseOutputTriangleCount: (outputBytes: ArrayBuffer) => number;
}

const FAMILIES: ConversionFamilySpec[] = [
  {
    operationId: "convert-obj-to-stl",
    outputExtension: "stl",
    validFile: objFile,
    invalidFile: invalidObjFile,
    createRunner: createDirectObjToStlRunner,
    reparseOutputTriangleCount: (bytes) => parseSTL(bytes, DEFAULT_STL_LIMITS).triangleCount,
  },
  {
    operationId: "convert-3mf-to-stl",
    outputExtension: "stl",
    validFile: threeMFFile,
    invalidFile: invalidThreeMFFile,
    createRunner: createDirectThreeMFToStlRunner,
    reparseOutputTriangleCount: (bytes) => parseSTL(bytes, DEFAULT_STL_LIMITS).triangleCount,
  },
  {
    operationId: "convert-glb-to-stl",
    outputExtension: "stl",
    validFile: glbFile,
    invalidFile: invalidGlbFile,
    createRunner: createDirectGlbToStlRunner,
    reparseOutputTriangleCount: (bytes) => parseSTL(bytes, DEFAULT_STL_LIMITS).triangleCount,
  },
  {
    operationId: "convert-ply-to-stl",
    outputExtension: "stl",
    validFile: plyFile,
    invalidFile: invalidPlyFile,
    createRunner: createDirectPlyToStlRunner,
    reparseOutputTriangleCount: (bytes) => parseSTL(bytes, DEFAULT_STL_LIMITS).triangleCount,
  },
  {
    operationId: "convert-stl-to-obj",
    outputExtension: "obj",
    validFile: stlFile,
    invalidFile: invalidStlFile,
    createRunner: createDirectStlToObjRunner,
    reparseOutputTriangleCount: (bytes) => {
      const text = new TextDecoder().decode(bytes);
      const doc = parseOBJDocument(text, DEFAULT_OBJ_LIMITS);
      return buildOBJGeometry(doc, DEFAULT_OBJ_LIMITS).triangleCount;
    },
  },
  {
    operationId: "convert-stl-to-3mf",
    outputExtension: "3mf",
    validFile: stlFile,
    invalidFile: invalidStlFile,
    createRunner: createDirectStlToThreeMFRunner,
    reparseOutputTriangleCount: (bytes) => {
      const pkg = openThreeMFPackage(bytes, DEFAULT_THREEMF_LIMITS);
      const modelPath = findPrimaryModelPath(pkg);
      const xml = new TextDecoder("utf-8", { fatal: false }).decode(pkg.readEntry(modelPath));
      const model = parseThreeMFModel(xml, DEFAULT_THREEMF_LIMITS);
      return resolveScene(model, DEFAULT_THREEMF_LIMITS).triangleCount;
    },
  },
];

describe.each(FAMILIES)("Batch conversion — $operationId (Phase 10 hotfix, Stage 5 full family coverage)", (spec) => {
  it("1. conversion succeeds, 2. individual output is available, 3. output reparses with the production parser", async () => {
    const queue = new BatchQueue();
    const runner = spec.createRunner();
    const job = queue.addFile({ file: spec.validFile(), displayName: spec.validFile().name, operationId: spec.operationId, settings: {} })!;
    const scheduler = new BatchScheduler(queue, runner);
    await runToCompletion(queue, scheduler);
    const finished = queue.getJob(job.id)!;
    expect(finished.state).toBe("succeeded");
    expect(finished.outputBytes).not.toBeNull();
    const triangleCount = spec.reparseOutputTriangleCount(finished.outputBytes!);
    expect(triangleCount).toBeGreaterThan(0);
    scheduler.dispose();
    queue.dispose();
  });

  it("9. report contains useful summary metadata, 10. report contains no raw geometry or binary output data", async () => {
    const queue = new BatchQueue();
    const runner = spec.createRunner();
    queue.addFile({ file: spec.validFile(), displayName: spec.validFile().name, operationId: spec.operationId, settings: {} });
    const scheduler = new BatchScheduler(queue, runner);
    await runToCompletion(queue, scheduler);
    const report = buildDownloadableBatchReport(queue.getJobs(), spec.operationId, {}, "generated");
    const serialized = JSON.stringify(report);
    expect(report.files[0].resultMeta).toBeTruthy();
    expect(serialized).not.toMatch(/"positions":\s*\{/);
    expect(serialized).not.toMatch(/"normals":\s*\{/);
    expect(serialized.length).toBeLessThan(5000);
    scheduler.dispose();
    queue.dispose();
  });

  it("4. JSON report downloads (builds successfully), 5. ZIP downloads (builds successfully), 6/7/8. ZIP contains the output, the per-file report, and batch-summary.json", async () => {
    const queue = new BatchQueue();
    const runner = spec.createRunner();
    const displayName = `zip-${spec.validFile().name}`;
    queue.addFile({ file: spec.validFile(), displayName, operationId: spec.operationId, settings: {} });
    const scheduler = new BatchScheduler(queue, runner);
    await runToCompletion(queue, scheduler);

    const jobs = queue.getJobs();
    const report = buildDownloadableBatchReport(jobs, spec.operationId, {}, "generated");
    // Exercise the report JSON download path directly.
    expect(() => JSON.stringify(report)).not.toThrow();

    const tracker = new FilenameCollisionTracker();
    const entries = jobs.map((job) => ({
      jobId: job.id,
      outputFilename: buildOutputFilename(job.displayName, spec.outputExtension, tracker),
      outputBytes: job.outputBytes,
      reportJson: JSON.stringify({ id: job.id, name: job.displayName, state: job.state, resultMeta: report.files.find((f) => f.safeFilename === job.displayName)?.resultMeta }),
      state: job.state,
    }));
    const zipBytes = buildBatchZip(entries, JSON.stringify(report));
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(zipBytes));
    const names = Object.keys(files);
    expect(names).toContain("batch-summary.json");
    expect(names.some((n) => n.startsWith("outputs/"))).toBe(true);
    expect(names.some((n) => n.startsWith("reports/"))).toBe(true);

    scheduler.dispose();
    queue.dispose();
  });

  it("11. invalid jobs stay isolated (one failure never blocks the other file), 12. only successful jobs appear in the ZIP's outputs/", async () => {
    const queue = new BatchQueue();
    const runner = spec.createRunner();
    const goodJob = queue.addFile({ file: spec.validFile(), displayName: "good", operationId: spec.operationId, settings: {} })!;
    const badJob = queue.addFile({ file: spec.invalidFile(), displayName: "bad", operationId: spec.operationId, settings: {} })!;
    const scheduler = new BatchScheduler(queue, runner);
    await runToCompletion(queue, scheduler);

    expect(queue.getJob(goodJob.id)!.state).toBe("succeeded");
    expect(queue.getJob(badJob.id)!.state).toBe("failed");

    const jobs = queue.getJobs();
    const report = buildDownloadableBatchReport(jobs, spec.operationId, {}, "generated");
    const tracker = new FilenameCollisionTracker();
    const entries = jobs.map((job) => ({
      jobId: job.id,
      outputFilename: buildOutputFilename(job.displayName, spec.outputExtension, tracker),
      outputBytes: job.outputBytes,
      reportJson: JSON.stringify({ id: job.id, resultMeta: report.files.find((f) => f.safeFilename === job.displayName)?.resultMeta }),
      state: job.state,
    }));
    const zipBytes = buildBatchZip(entries, JSON.stringify(report));
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(zipBytes));
    const outputEntries = Object.keys(files).filter((n) => n.startsWith("outputs/"));
    expect(outputEntries).toHaveLength(1); // only the succeeded job
    const reportEntries = Object.keys(files).filter((n) => n.startsWith("reports/"));
    expect(reportEntries).toHaveLength(2); // both jobs, succeeded or not

    scheduler.dispose();
    queue.dispose();
  });
});

describe("Batch conversion — large-fixture regression (proves the RangeError-on-report-download crash is fixed end-to-end)", () => {
  function largeObjFile(nx: number, ny: number): File {
    const lines: string[] = [];
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) lines.push(`v ${x} ${y} 0`);
    const vertsPerRow = nx + 1;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const a = y * vertsPerRow + x + 1,
          b = y * vertsPerRow + x + 2,
          c = (y + 1) * vertsPerRow + x + 2,
          d = (y + 1) * vertsPerRow + x + 1;
        lines.push(`f ${a} ${b} ${c}`);
        lines.push(`f ${a} ${c} ${d}`);
      }
    }
    return new File([lines.join("\n") + "\n"], "large.obj", { type: "model/obj" });
  }

  it("a 100,000+ triangle OBJ→STL batch report and ZIP both generate successfully with no uncaught RangeError, and stay a small, bounded size", async () => {
    const queue = new BatchQueue();
    const runner = createDirectObjToStlRunner();
    // 250x250 grid = 125,000 triangles — large enough that the OLD spread-based
    // resultMeta (positions+normals as numbered-key JSON objects) would produce
    // a multi-hundred-megabyte report string; this reproduction is intentionally
    // smaller than what triggered the original RangeError, so the test itself
    // doesn't need to allocate hundreds of MB to prove the fix.
    const job = queue.addFile({ file: largeObjFile(250, 250), displayName: "large.obj", operationId: "convert-obj-to-stl", settings: {} })!;
    const scheduler = new BatchScheduler(queue, runner);
    await runToCompletion(queue, scheduler, 15000);
    expect(queue.getJob(job.id)!.state).toBe("succeeded");

    const jobs = queue.getJobs();
    let report: ReturnType<typeof buildDownloadableBatchReport> | undefined;
    expect(() => {
      report = buildDownloadableBatchReport(jobs, "convert-obj-to-stl", {}, "generated");
      JSON.stringify(report);
    }).not.toThrow();
    const serialized = JSON.stringify(report);
    // Proportional to file COUNT, not model complexity — a bound that would
    // fail instantly under the old defect regardless of exact triangle count.
    expect(serialized.length).toBeLessThan(5000);

    scheduler.dispose();
    queue.dispose();
  }, 20000);
});
