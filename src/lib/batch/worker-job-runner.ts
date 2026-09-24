/**
 * The one shared `JobRunner` implementation every batch adapter
 * configures rather than reimplementing — instantiates a fresh
 * `WorkerClient` (and thus a fresh real `Worker`) per job, exactly the
 * same shared worker-communication layer every single-file page already
 * uses. `adapter-registry.ts` supplies only what differs per operation:
 * which worker file to load, the `process()` `format` label, how to
 * turn a job's settings into the worker's own `options`, which progress
 * stage(s) mean "now verifying" rather than "still processing", and how
 * to pull `{ resultMeta, outputBytes }` out of that operation's own
 * (differently-shaped) result envelope.
 */
import { createSafeError } from "../errors";
import { WorkerClient, type WorkerFactory } from "../workers/worker-client";
import type { JobRunContext, JobRunOutcome, JobRunner } from "./scheduler";
import type { BatchJob } from "./types";

export interface UnwrappedResult {
  resultMeta: unknown;
  outputBytes: ArrayBuffer;
}

export interface WorkerJobRunnerConfig<TSettings> {
  createWorker: WorkerFactory;
  /** Passed as `process()`'s `format` argument — informational for the worker, matches this project's existing single-file convention. */
  formatLabel: string;
  buildOptions: (settings: TSettings) => Record<string, unknown>;
  /** Progress-stage names (exact strings the worker posts) that mean "now verifying," not "still processing." */
  verifyingStages: readonly string[];
  /** Returns `null` to treat an otherwise-successful worker result as a failure (e.g. the operation's own outcome field reports something batch treats as not-succeeded). */
  unwrapResult: (raw: unknown) => UnwrappedResult | null;
}

export function createWorkerJobRunner<TSettings>(config: WorkerJobRunnerConfig<TSettings>): JobRunner {
  return {
    run(job: BatchJob, context: JobRunContext): Promise<JobRunOutcome> {
      return new Promise<JobRunOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: JobRunOutcome): void => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        let client: WorkerClient;
        client = new WorkerClient(config.createWorker, {
          onReady: () => {
            if (context.isCancelled()) {
              client.dispose();
              settle({ ok: false, error: createSafeError("PROCESS_CANCELLED") });
              return;
            }
            void job.file.arrayBuffer().then((buffer) => {
              if (context.isCancelled()) {
                client.dispose();
                settle({ ok: false, error: createSafeError("PROCESS_CANCELLED") });
                return;
              }
              client.process(job.file.name, config.formatLabel, buffer, config.buildOptions(job.settings as TSettings));
            });
          },
          onProgress: (stage) => {
            if (context.isCancelled()) {
              client.cancel();
              return;
            }
            if (config.verifyingStages.includes(stage)) context.enterState("verifying");
            context.onProgress(stage, 0);
          },
          onResult: (raw) => {
            const unwrapped = config.unwrapResult(raw);
            client.dispose();
            if (!unwrapped) {
              settle({ ok: false, error: createSafeError("UNKNOWN_ERROR") });
              return;
            }
            settle({ ok: true, resultMeta: unwrapped.resultMeta, outputBytes: unwrapped.outputBytes });
          },
          onError: (error) => {
            client.dispose();
            settle({ ok: false, error });
          },
          onCancelled: () => {
            client.dispose();
            settle({ ok: false, error: createSafeError("PROCESS_CANCELLED") });
          },
        });

        try {
          client.initialize();
        } catch {
          settle({ ok: false, error: createSafeError("WORKER_INIT_FAILED") });
        }
      });
    },
  };
}
