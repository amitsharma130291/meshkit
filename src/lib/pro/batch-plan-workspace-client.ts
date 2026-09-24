/**
 * The HEAVY, dynamically-imported engine behind `BatchPlanWorkspace.astro`
 * — shared by both batch repair and batch optimization, since both need
 * the identical `files selected → plan → confirm → run` shape. Operation-
 * specific pieces (settings shape, the real plan function, how to
 * render a plan summary, the preset store) are supplied by the caller
 * (`batch-repair-plan-client.ts` / `batch-optimize-plan-client.ts`);
 * this module owns no format-specific logic itself.
 *
 * Receives an already-built `EntitlementStore`/`FeatureGate`, exactly
 * like `batch-workspace-client.ts` — entitlement is always an explicit
 * dependency, never resolved internally.
 */
import { getAdapter } from "../batch/adapter-registry";
import { validateIntake, DEFAULT_FILE_INTAKE_LIMITS } from "../batch/file-intake";
import { FilenameCollisionTracker, buildOutputFilename } from "../batch/filenames";
import { MemoryBudget } from "../batch/memory-budget";
import { PlanWorkflow, type PlanEntry } from "../batch/plan-workflow";
import { BatchQueue } from "../batch/queue-state";
import { buildDownloadableBatchReport, sanitizeJobResultMetaForReport } from "../batch/report";
import { ResultStore } from "../batch/result-store";
import { BatchScheduler } from "../batch/scheduler";
import type { BatchJob, BatchJobState, BatchOperationId } from "../batch/types";
import { buildBatchZip } from "../batch/zip-download";

const DEFAULT_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

const STATE_LABELS: Record<BatchJobState, string> = {
  queued: "Queued",
  validating: "Validating",
  processing: "Processing",
  verifying: "Verifying",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

function outputMimeType(extension: string): string {
  if (extension === "stl") return "model/stl";
  if (extension === "obj") return "model/obj";
  if (extension === "3mf") return "model/3mf";
  return "application/octet-stream";
}

export interface PlanSummaryText {
  issues: string;
  planned: string;
  skipped: string;
  eligibility: string;
  warnings: string;
}

export interface BatchPlanEngineConfig<TSettings, TPlan> {
  operationId: BatchOperationId;
  capability: string;
  planFile: (file: File, settings: TSettings) => Promise<TPlan>;
  getSettings: () => TSettings;
  renderPlanSummary: (plan: TPlan) => PlanSummaryText;
}

export type InitBatchPlanWorkspaceEngine = typeof initBatchPlanWorkspaceEngine;

export function initBatchPlanWorkspaceEngine<TSettings, TPlan>(
  root: HTMLElement,
  config: BatchPlanEngineConfig<TSettings, TPlan>,
): void {
  const dropzone = root.querySelector<HTMLElement>("[data-batch-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-batch-file-input]");
  const stageIntake = root.querySelector<HTMLElement>("[data-batch-stage-intake]");
  const stagePlan = root.querySelector<HTMLElement>("[data-batch-stage-plan]");
  const stageRun = root.querySelector<HTMLElement>("[data-batch-stage-run]");
  const intakeSummary = root.querySelector<HTMLElement>("[data-batch-intake-summary]");
  const stagedRows = root.querySelector<HTMLElement>("[data-batch-staged-rows]");
  const stagedRowTemplate = root.querySelector<HTMLTemplateElement>("[data-batch-staged-row-template]");
  const planRows = root.querySelector<HTMLElement>("[data-batch-plan-rows]");
  const planRowTemplate = root.querySelector<HTMLTemplateElement>("[data-batch-plan-row-template]");
  const analyzeButton = root.querySelector<HTMLButtonElement>('[data-action="analyze-and-plan"]');
  const cancelPlanningButton = root.querySelector<HTMLButtonElement>('[data-action="cancel-planning"]');
  const backToIntakeButton = root.querySelector<HTMLButtonElement>('[data-action="back-to-intake"]');
  const confirmButton = root.querySelector<HTMLButtonElement>('[data-action="confirm-plan"]');
  const summary = root.querySelector<HTMLElement>("[data-batch-queue-summary]");
  const rowsContainer = root.querySelector<HTMLElement>("[data-batch-file-rows]");
  const rowTemplate = root.querySelector<HTMLTemplateElement>("[data-batch-row-template]");
  const cancelAllButton = root.querySelector<HTMLButtonElement>('[data-action="cancel-all"]');
  const clearCompletedButton = root.querySelector<HTMLButtonElement>('[data-action="clear-completed"]');
  const downloadZipButton = root.querySelector<HTMLButtonElement>('[data-action="download-zip"]');
  const downloadReportButton = root.querySelector<HTMLButtonElement>('[data-action="download-batch-report"]');
  const concurrencyRadios = root.querySelectorAll<HTMLInputElement>("[data-batch-concurrency] input[type=radio]");
  const concurrencyStatus = root.querySelector<HTMLElement>("[data-batch-concurrency-status]");

  if (
    !dropzone || !fileInput || !stageIntake || !stagePlan || !stageRun || !intakeSummary || !stagedRows || !stagedRowTemplate ||
    !planRows || !planRowTemplate || !analyzeButton || !confirmButton || !summary || !rowsContainer || !rowTemplate
  ) {
    return;
  }
  const el = {
    dropzone, fileInput, stageIntake, stagePlan, stageRun, intakeSummary, stagedRows, stagedRowTemplate,
    planRows, planRowTemplate, analyzeButton, confirmButton, summary, rowsContainer, rowTemplate,
  };

  const adapter = getAdapter(config.operationId);
  const workflow = new PlanWorkflow<TSettings, TPlan>(config.planFile, config.getSettings());
  const outputNames = new FilenameCollisionTracker();
  const resolvedOutputNames = new Map<string, string>();
  let resultStore: ResultStore | null = null;
  let queue: BatchQueue | null = null;
  let scheduler: BatchScheduler | null = null;

  // --- Concurrency control ---------------------------------------------------------
  function getSelectedConcurrency(): number {
    const checked = [...concurrencyRadios].find((r) => r.checked);
    return checked ? Number(checked.value) : 1;
  }
  function renderConcurrencyStatus(): void {
    if (!concurrencyStatus || !scheduler || !queue) return;
    const configured = scheduler.getConfiguredConcurrency();
    const effective = scheduler.getEffectiveConcurrency();
    const waiting = queue.getJobs().some((j) => j.state === "queued");
    concurrencyStatus.textContent =
      effective < configured && waiting
        ? `Configured for ${configured}, but only ${effective} running right now (memory budget).`
        : `Running ${effective} of ${configured} configured.`;
  }
  for (const radio of concurrencyRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked || !scheduler) return;
      if (!scheduler.setConcurrency(Number(radio.value))) radio.checked = false;
      renderConcurrencyStatus();
    });
  }

  // --- Stage 1: intake ---------------------------------------------------------
  function renderStaged(): void {
    el.stagedRows.innerHTML = "";
    for (const entry of workflow.getEntries()) {
      const fragment = el.stagedRowTemplate.content.cloneNode(true) as DocumentFragment;
      const rowEl = fragment.querySelector<HTMLElement>(".batch-staged-row")!;
      rowEl.querySelector('[data-cell="name"]')!.textContent = entry.displayName;
      rowEl.querySelector('[data-cell="size"]')!.textContent = `${(entry.file.size / 1024).toFixed(1)} KB`;
      rowEl.querySelector<HTMLButtonElement>('[data-row-action="remove"]')!.addEventListener("click", () => {
        workflow.removeFile(entry.id);
        renderStaged();
      });
      el.stagedRows.appendChild(fragment);
    }
    const count = workflow.getEntries().length;
    el.intakeSummary.textContent = count === 0 ? "No files added yet." : `${count} file(s) staged.`;
    el.analyzeButton.disabled = count === 0;
  }

  function intake(files: FileList | File[]): void {
    const result = validateIntake(Array.from(files), adapter.acceptedExtensions, DEFAULT_FILE_INTAKE_LIMITS, {
      alreadyQueuedCount: workflow.getEntries().length,
    });
    for (const file of result.accepted) workflow.addFile(file, file.name);
    renderStaged();
  }

  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      el.fileInput.click();
    }
  });
  el.dropzone.addEventListener("dragover", (event) => event.preventDefault());
  el.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files) intake(event.dataTransfer.files);
  });
  el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files) intake(el.fileInput.files);
    el.fileInput.value = "";
  });

  // --- Stage 2: plan review ---------------------------------------------------------
  function renderPlan(): void {
    el.planRows.innerHTML = "";
    for (const entry of workflow.getEntries()) {
      const fragment = el.planRowTemplate.content.cloneNode(true) as DocumentFragment;
      const rowEl = fragment.querySelector<HTMLElement>(".batch-plan-row")!;
      rowEl.querySelector('[data-cell="name"]')!.textContent = entry.displayName;
      const statusEl = rowEl.querySelector('[data-cell="status"]')!;
      const detailsEl = rowEl.querySelector<HTMLElement>('[data-cell="details"]')!;

      if (entry.state === "planning") statusEl.textContent = "Analyzing…";
      else if (entry.state === "failed") statusEl.textContent = `Could not analyze this file — ${entry.error?.message ?? "unknown error"}`;
      else if (entry.state === "stale") statusEl.textContent = "Settings changed — re-plan to continue.";
      else if (entry.state === "planned" && entry.plan) {
        const text = config.renderPlanSummary(entry.plan);
        statusEl.textContent = "Planned.";
        detailsEl.hidden = false;
        detailsEl.querySelector('[data-plan="issues"]')!.textContent = text.issues;
        detailsEl.querySelector('[data-plan="planned"]')!.textContent = text.planned;
        detailsEl.querySelector('[data-plan="skipped"]')!.textContent = text.skipped;
        detailsEl.querySelector('[data-plan="eligibility"]')!.textContent = text.eligibility;
        detailsEl.querySelector('[data-plan="warnings"]')!.textContent = text.warnings;
      } else {
        statusEl.textContent = "Pending.";
      }
      el.planRows.appendChild(fragment);
    }

    const allTerminal = workflow.getEntries().every((e: PlanEntry<TPlan>) => e.state === "planned" || e.state === "failed");
    el.confirmButton.disabled = !(allTerminal && workflow.getEntries().length > 0);
  }

  // Without this, the plan list only ever re-rendered once `planAll()`
  // fully settled — for a large file that can take many seconds, every
  // row sat on "Pending." with zero feedback the whole time, looking
  // exactly like a hang. `PlanWorkflow` already calls `notify()` on
  // every per-entry transition (pending → planning → planned/failed);
  // this just makes the UI actually listen for it.
  workflow.subscribe(renderPlan);

  el.analyzeButton.addEventListener("click", () => {
    el.stageIntake.hidden = true;
    el.stagePlan.hidden = false;
    cancelPlanningButton && (cancelPlanningButton.hidden = false);
    renderPlan();
    void workflow.planAll().then(() => {
      if (cancelPlanningButton) cancelPlanningButton.hidden = true;
      renderPlan();
    });
  });

  cancelPlanningButton?.addEventListener("click", () => {
    workflow.cancelPlanning();
  });

  backToIntakeButton?.addEventListener("click", () => {
    el.stagePlan.hidden = true;
    el.stageIntake.hidden = false;
    renderStaged();
  });

  // --- Stage 3: run ---------------------------------------------------------
  function jobDownloadUrl(job: BatchJob): string | null {
    if (!job.outputBytes || !resultStore) return null;
    return resultStore.getOrCreateUrl(job.id, job.outputBytes, outputMimeType(adapter.outputExtension));
  }

  function jobOutputFilename(job: BatchJob): string {
    const existing = resolvedOutputNames.get(job.id);
    if (existing) return existing;
    const name = buildOutputFilename(job.displayName, adapter.outputExtension, outputNames);
    resolvedOutputNames.set(job.id, name);
    return name;
  }

  function renderRun(): void {
    if (!queue) return;
    const jobs = queue.getJobs();
    el.rowsContainer.innerHTML = "";
    for (const job of jobs) {
      const fragment = el.rowTemplate.content.cloneNode(true) as DocumentFragment;
      const rowEl = fragment.querySelector<HTMLElement>(".batch-file-row")!;
      rowEl.dataset.jobId = job.id;
      rowEl.querySelector('[data-cell="name"]')!.textContent = job.displayName;
      rowEl.querySelector('[data-cell="state"]')!.textContent = job.error ? `${STATE_LABELS[job.state]} — ${job.error.message}` : STATE_LABELS[job.state];
      const progressEl = rowEl.querySelector("progress")!;
      progressEl.value = Math.round(job.progressValue * 100);

      const retryBtn = rowEl.querySelector<HTMLButtonElement>('[data-row-action="retry"]')!;
      const cancelBtn = rowEl.querySelector<HTMLButtonElement>('[data-row-action="cancel"]')!;
      const removeBtn = rowEl.querySelector<HTMLButtonElement>('[data-row-action="remove"]')!;
      const downloadLink = rowEl.querySelector<HTMLAnchorElement>('[data-row-action="download"]')!;

      if (job.state === "failed" || job.state === "cancelled") retryBtn.hidden = false;
      if (job.state === "queued" || job.state === "validating" || job.state === "processing" || job.state === "verifying") cancelBtn.hidden = false;
      if (job.state !== "processing" && job.state !== "validating" && job.state !== "verifying") removeBtn.hidden = false;
      if (job.state === "succeeded") {
        const url = jobDownloadUrl(job);
        if (url) {
          downloadLink.hidden = false;
          downloadLink.href = url;
          downloadLink.download = jobOutputFilename(job);
        }
      }

      retryBtn.addEventListener("click", () => queue!.retry(job.id));
      cancelBtn.addEventListener("click", () => queue!.cancel(job.id));
      removeBtn.addEventListener("click", () => {
        resultStore?.revoke(job.id);
        resolvedOutputNames.delete(job.id);
        queue!.removeJob(job.id);
      });

      el.rowsContainer.appendChild(fragment);
    }

    const succeeded = jobs.filter((j) => j.state === "succeeded").length;
    const failed = jobs.filter((j) => j.state === "failed").length;
    el.summary.textContent = jobs.length === 0 ? "No files in this batch." : `${jobs.length} file(s) — ${succeeded} succeeded, ${failed} failed.`;
    if (downloadZipButton) downloadZipButton.disabled = succeeded === 0;
    if (downloadReportButton) downloadReportButton.disabled = jobs.length === 0;
    renderConcurrencyStatus();
  }

  el.confirmButton.addEventListener("click", () => {
    if (!workflow.confirm()) return;
    el.stagePlan.hidden = true;
    el.stageRun.hidden = false;

    const memoryBudget = new MemoryBudget({ maxTotalBytes: DEFAULT_MEMORY_BUDGET_BYTES });
    resultStore = new ResultStore(URL);
    queue = new BatchQueue();
    scheduler = new BatchScheduler(queue, adapter.runner, { concurrency: getSelectedConcurrency(), memoryBudget });

    for (const entry of workflow.getEntries()) {
      if (entry.state !== "planned") continue; // failed-to-plan entries never run
      queue.addFile({ file: entry.file, displayName: entry.displayName, operationId: config.operationId, settings: config.getSettings() });
    }
    queue.subscribe(renderRun);
    scheduler.start();
    renderRun();
    renderConcurrencyStatus();
  });

  cancelAllButton?.addEventListener("click", () => queue?.cancelAll());
  clearCompletedButton?.addEventListener("click", () => {
    if (!queue) return;
    for (const job of queue.getJobs()) {
      if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
        resultStore?.revoke(job.id);
        resolvedOutputNames.delete(job.id);
      }
    }
    queue.clearCompleted();
  });

  downloadZipButton?.addEventListener("click", () => {
    if (!queue) return;
    const jobs = queue.getJobs();
    const zipTracker = new FilenameCollisionTracker();
    const entries = jobs.map((job) => ({
      jobId: job.id,
      outputFilename: buildOutputFilename(job.displayName, adapter.outputExtension, zipTracker),
      outputBytes: job.outputBytes,
      reportJson: JSON.stringify({ id: job.id, name: job.displayName, state: job.state, resultMeta: sanitizeJobResultMetaForReport(config.operationId, job.resultMeta) }),
      state: job.state,
    }));
    const summaryReport = buildDownloadableBatchReport(jobs, config.operationId, config.getSettings(), "generated");
    try {
      const zipBytes = buildBatchZip(entries, JSON.stringify(summaryReport));
      const url = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "batch-results.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ceiling exceeded or generation failed — button stays enabled to retry.
    }
  });

  downloadReportButton?.addEventListener("click", () => {
    if (!queue) return;
    const report = buildDownloadableBatchReport(queue.getJobs(), config.operationId, config.getSettings(), "not-generated");
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "batch-report.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  window.addEventListener("pagehide", () => {
    workflow.dispose();
    scheduler?.dispose();
    queue?.dispose();
    resultStore?.dispose();
  });

  renderStaged();
}
