/**
 * The one exhaustive registry of batch adapters — each a thin
 * configuration of `createWorkerJobRunner()` pointing at the EXACT same
 * worker file and library a single-file page already uses. No adapter
 * here re-implements a parser, converter, repair or optimization
 * algorithm; this module only wires: which worker to load, how to turn
 * a job's settings into that worker's own `options`, which progress
 * stage(s) mean "now verifying," and how to pull `{ resultMeta,
 * outputBytes }` out of that operation's own result envelope (the eight
 * operations don't share one envelope shape — see
 * `worker-job-runner.ts`'s own doc comment and the per-adapter
 * `unwrap*` functions below).
 */
import { safePreset, type RepairSettings } from "../stl-repair/types";
import { defaultOptimizeSettings, type OptimizeSettings } from "../mesh-optimization/types";
import type { WorkerFactory } from "../workers/worker-client";
import type { BatchAdapter } from "./adapter-types";
import type { BatchOperationId } from "./types";
import { OPERATION_MEMORY_MULTIPLIERS } from "./memory-budget";
import { createWorkerJobRunner, type UnwrappedResult } from "./worker-job-runner";
import {
  type ConversionResultMeta,
  projectGlbToStlMeta,
  projectObjToStlMeta,
  projectPlyToStlMeta,
  projectStlToObjMeta,
  projectStlToThreeMFMeta,
  projectThreeMFToStlMeta,
} from "./conversion-result-meta";

export const ALL_BATCH_OPERATION_IDS: readonly BatchOperationId[] = [
  "convert-3mf-to-stl",
  "convert-obj-to-stl",
  "convert-glb-to-stl",
  "convert-ply-to-stl",
  "convert-stl-to-obj",
  "convert-stl-to-3mf",
  "repair-stl",
  "optimize-stl",
];

/**
 * Every conversion worker posts its RESULT bare (not wrapped in a
 * `{mode, ...}` envelope like repair/optimize) — this splits it into the
 * byte buffer (by its own field name) and an explicitly PROJECTED
 * `resultMeta`, via the caller-supplied `project` function
 * (`conversion-result-meta.ts`'s `project*Meta()` functions — one per
 * format). This never spreads the raw record: a conversion worker's
 * result also carries the full `positions`/`normals` source-geometry
 * arrays it returns for the single-file viewport preview, and a raw
 * spread used to leak those straight into a downloadable batch report
 * (a confirmed defect, fixed here — see `conversion-result-meta.ts`'s
 * own doc comment for the full record).
 */
export function unwrapConversionResult(raw: unknown, bufferKey: string, project: (raw: unknown) => ConversionResultMeta): UnwrappedResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const buffer = record[bufferKey];
  if (!(buffer instanceof ArrayBuffer)) return null;
  return { resultMeta: project(record), outputBytes: buffer };
}

/**
 * Repair always reparses and reverifies its own output before this point
 * — `outputBytes` is non-null for every outcome except a hard pipeline
 * failure or cancellation, so a batch job is "succeeded" whenever
 * output exists at all. The (possibly less-than-perfect) outcome itself
 * — `"unable-to-repair-safely"`, `"partially-repaired"`, etc. — is
 * preserved verbatim in `resultMeta` so the batch report stays honest,
 * never silently upgraded to "fully repaired."
 */
export function unwrapRepairResult(raw: unknown): UnwrappedResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.mode !== "repair" || typeof record.repair !== "object" || record.repair === null) return null;
  const repair = record.repair as Record<string, unknown>;
  const outputBytes = repair.outputBytes;
  if (!(outputBytes instanceof ArrayBuffer)) return null;
  const { outputBytes: _omit, overlays: _overlays, ...resultMeta } = repair;
  return { resultMeta, outputBytes };
}

const OPTIMIZE_FAILURE_OUTCOMES = new Set(["verification-failed", "verification-incomplete", "cancelled", "failed"]);

/**
 * Optimize's own reparse/reverify pass can produce non-null
 * `outputBytes` even when the verified result fails a quality-policy
 * threshold — `outcome` is checked explicitly here, never just
 * `outputBytes`'s nullness, so a `"verification-failed"` result is
 * never mistaken for a successful batch job just because bytes exist.
 */
export function unwrapOptimizeResult(raw: unknown): UnwrappedResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.mode !== "optimize" || typeof record.optimize !== "object" || record.optimize === null) return null;
  const optimize = record.optimize as Record<string, unknown>;
  const outputBytes = optimize.outputBytes;
  if (!(outputBytes instanceof ArrayBuffer)) return null;
  if (typeof optimize.outcome === "string" && OPTIMIZE_FAILURE_OUTCOMES.has(optimize.outcome)) return null;
  const { outputBytes: _omit, ...resultMeta } = optimize;
  return { resultMeta, outputBytes };
}

function createConversionWorker(workerRelativePath: string): WorkerFactory {
  return () => new Worker(new URL(workerRelativePath, import.meta.url), { type: "module" });
}

function conversionAdapter(
  operationId: BatchOperationId,
  acceptedExtension: string,
  outputExtension: string,
  workerRelativePath: string,
  bufferKey: string,
  project: (raw: unknown) => ConversionResultMeta,
): BatchAdapter<Record<string, never>> {
  return {
    operationId,
    acceptedExtensions: [acceptedExtension],
    outputExtension,
    memoryMultiplier: OPERATION_MEMORY_MULTIPLIERS[operationId],
    defaultSettings: {},
    createWorker: createConversionWorker(workerRelativePath),
    runner: createWorkerJobRunner<Record<string, never>>({
      createWorker: createConversionWorker(workerRelativePath),
      formatLabel: acceptedExtension,
      buildOptions: () => ({}),
      verifyingStages: [],
      unwrapResult: (raw) => unwrapConversionResult(raw, bufferKey, project),
    }),
  };
}

const repairAdapter: BatchAdapter<RepairSettings> = {
  operationId: "repair-stl",
  acceptedExtensions: ["stl"],
  outputExtension: "stl",
  memoryMultiplier: OPERATION_MEMORY_MULTIPLIERS["repair-stl"],
  defaultSettings: safePreset(),
  createWorker: createConversionWorker("../../workers/stl-repair.worker.ts"),
  runner: createWorkerJobRunner<RepairSettings>({
    createWorker: createConversionWorker("../../workers/stl-repair.worker.ts"),
    formatLabel: "stl",
    buildOptions: (settings) => ({ mode: "repair", settings }),
    verifyingStages: ["verifying-repaired-stl"],
    unwrapResult: unwrapRepairResult,
  }),
};

const optimizeAdapter: BatchAdapter<OptimizeSettings> = {
  operationId: "optimize-stl",
  acceptedExtensions: ["stl"],
  outputExtension: "stl",
  memoryMultiplier: OPERATION_MEMORY_MULTIPLIERS["optimize-stl"],
  defaultSettings: defaultOptimizeSettings(),
  createWorker: createConversionWorker("../../workers/stl-optimizer.worker.ts"),
  runner: createWorkerJobRunner<OptimizeSettings>({
    createWorker: createConversionWorker("../../workers/stl-optimizer.worker.ts"),
    formatLabel: "stl",
    buildOptions: (settings) => ({ mode: "optimize", settings }),
    verifyingStages: ["verifying-optimized-stl"],
    unwrapResult: unwrapOptimizeResult,
  }),
};

// Every conversion worker already hardcodes its own `DEFAULT_*_LIMITS`
// internally (the same ones its single-file page relies on) — batch
// never passes or overrides a limits object of its own, so it can never
// silently loosen a safety ceiling the single-file tool enforces.
const registry: Record<BatchOperationId, BatchAdapter<unknown>> = {
  "convert-3mf-to-stl": conversionAdapter("convert-3mf-to-stl", "3mf", "stl", "../../workers/threemf-to-stl.worker.ts", "stlBuffer", projectThreeMFToStlMeta),
  "convert-obj-to-stl": conversionAdapter("convert-obj-to-stl", "obj", "stl", "../../workers/obj-to-stl.worker.ts", "stlBuffer", projectObjToStlMeta),
  "convert-glb-to-stl": conversionAdapter("convert-glb-to-stl", "glb", "stl", "../../workers/glb-to-stl.worker.ts", "stlBuffer", projectGlbToStlMeta),
  "convert-ply-to-stl": conversionAdapter("convert-ply-to-stl", "ply", "stl", "../../workers/ply-to-stl.worker.ts", "stlBuffer", projectPlyToStlMeta),
  "convert-stl-to-obj": conversionAdapter("convert-stl-to-obj", "stl", "obj", "../../workers/stl-to-obj.worker.ts", "objBuffer", projectStlToObjMeta),
  "convert-stl-to-3mf": conversionAdapter("convert-stl-to-3mf", "stl", "3mf", "../../workers/stl-to-threemf.worker.ts", "threeMFBuffer", projectStlToThreeMFMeta),
  "repair-stl": repairAdapter as BatchAdapter<unknown>,
  "optimize-stl": optimizeAdapter as BatchAdapter<unknown>,
};

export function getAdapter(operationId: BatchOperationId): BatchAdapter<unknown> {
  return registry[operationId];
}
