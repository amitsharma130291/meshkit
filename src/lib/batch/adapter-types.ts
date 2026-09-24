/**
 * The shared contract every batch adapter implements. An adapter is a
 * THIN wrapper around the exact same production worker/library a
 * single-file page already uses (`adapter-registry.ts`'s own doc
 * comment names each source) — this module only defines the shape, it
 * never contains format-specific logic itself.
 */
import type { WorkerFactory } from "../workers/worker-client";
import type { BatchJob, BatchOperationId } from "./types";
import type { JobRunContext, JobRunOutcome, JobRunner } from "./scheduler";

export interface BatchAdapter<TSettings = unknown> {
  readonly operationId: BatchOperationId;
  /** Lowercase, no dot (e.g. `"stl"`). */
  readonly acceptedExtensions: readonly string[];
  readonly outputExtension: string;
  readonly memoryMultiplier: number;
  readonly defaultSettings: TSettings;
  readonly createWorker: WorkerFactory;
  readonly runner: JobRunner;
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

export function matchesAcceptedExtension(name: string, accepted: readonly string[]): boolean {
  return accepted.includes(fileExtension(name));
}

export type { JobRunContext, JobRunOutcome, JobRunner, BatchJob };
