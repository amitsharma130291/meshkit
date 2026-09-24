/**
 * The HEAVY half of a page's batch integration — pulls in the whole
 * `src/lib/batch/` tree (queue, scheduler, adapter registry, ZIP/report
 * builders, `fflate`). Never imported statically: `batch-entitlement-gate.ts`
 * dynamically `import()`s this module, and only after its own capability
 * check has already confirmed Pro — a Free user's page load never
 * fetches this chunk at all.
 *
 * Receives an already-built `EntitlementStore`/`FeatureGate` rather than
 * constructing its own, so entitlement wiring (including the dev-only
 * test-provider injection) stays owned by the lightweight gate module.
 */
import { getAdapter } from "../batch/adapter-registry";
import { validateIntake, DEFAULT_FILE_INTAKE_LIMITS } from "../batch/file-intake";
import { FilenameCollisionTracker, buildOutputFilename } from "../batch/filenames";
import { MemoryBudget } from "../batch/memory-budget";
import { BatchQueue } from "../batch/queue-state";
import { buildDownloadableBatchReport, sanitizeJobResultMetaForReport } from "../batch/report";
import { ResultStore } from "../batch/result-store";
import { BatchScheduler } from "../batch/scheduler";
import type { BatchJob, BatchJobState, BatchOperationId } from "../batch/types";
import { buildBatchZip } from "../batch/zip-download";
import type { EntitlementStore } from "./entitlement-store";
import type { FeatureGate } from "./feature-gate";

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

export type InitBatchWorkspaceEngine = typeof initBatchWorkspaceEngine;

export function initBatchWorkspaceEngine(root: HTMLElement, operationId: BatchOperationId, entitlementStore: EntitlementStore, gate: FeatureGate): void {
  const dropzone = root.querySelector<HTMLElement>("[data-batch-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-batch-file-input]");
  const summary = root.querySelector<HTMLElement>("[data-batch-queue-summary]");
  const rowsContainer = root.querySelector<HTMLElement>("[data-batch-file-rows]");
  const rowTemplate = document.querySelector<HTMLTemplateElement>("[data-batch-row-template]");
  const cancelAllButton = root.querySelector<HTMLButtonElement>('[data-action="cancel-all"]');
  const clearCompletedButton = root.querySelector<HTMLButtonElement>('[data-action="clear-completed"]');
  const downloadZipButton = root.querySelector<HTMLButtonElement>('[data-action="download-zip"]');
  const downloadReportButton = root.querySelector<HTMLButtonElement>('[data-action="download-batch-report"]');
  const concurrencyRadios = root.querySelectorAll<HTMLInputElement>("[data-batch-concurrency] input[type=radio]");
  const concurrencyStatus = root.querySelector<HTMLElement>("[data-batch-concurrency-status]");

  if (!dropzone || !fileInput || !summary || !rowsContainer || !rowTemplate) return;
  // TS doesn't carry the null-check above through the closures declared
  // below, so each required element is rebound here to a definitely-typed
  // const the closures actually capture.
  const elements = { dropzone, fileInput, summary, rowsContainer, rowTemplate };
  const { dropzone: dropzoneEl, fileInput: fileInputEl, summary: summaryEl, rowsContainer: rowsContainerEl, rowTemplate: rowTemplateEl } = elements;

  const adapter = getAdapter(operationId);
  const queue = new BatchQueue();
  const memoryBudget = new MemoryBudget({ maxTotalBytes: DEFAULT_MEMORY_BUDGET_BYTES });
  const resultStore = new ResultStore(URL);
  const outputNames = new FilenameCollisionTracker();
  const scheduler = new BatchScheduler(queue, adapter.runner, { concurrency: 1, memoryBudget });
  scheduler.start();

  // --- Concurrency control ---------------------------------------------------------
  function renderConcurrencyStatus(): void {
    if (!concurrencyStatus) return;
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
      if (!radio.checked) return;
      const value = Number(radio.value);
      if (!scheduler.setConcurrency(value)) radio.checked = false;
      renderConcurrencyStatus();
    });
  }
  renderConcurrencyStatus();

  // Entitlement can change after this engine has already loaded (a
  // capability revoked while idle, with queued jobs, or mid-processing):
  // never start a NEW queued job once lost, but never abandon or corrupt
  // work already in flight — it's allowed to finish, and its output stays
  // downloadable. Regaining the capability resumes normal dispatch.
  gate.subscribe(() => {
    if (gate.can("batch-conversion") || gate.can("batch-repair") || gate.can("batch-optimization")) scheduler.resume();
    else scheduler.pause();
  });

  // --- Intake ---------------------------------------------------------
  function intake(files: FileList | File[]): void {
    const existingJobs = queue.getJobs();
    const result = validateIntake(Array.from(files), adapter.acceptedExtensions, DEFAULT_FILE_INTAKE_LIMITS, {
      alreadyQueuedCount: existingJobs.length,
      alreadyQueuedTotalBytes: existingJobs.reduce((sum, j) => sum + j.sourceSize, 0),
    });
    for (const file of result.accepted) {
      queue.addFile({ file, displayName: file.name, operationId, settings: adapter.defaultSettings });
    }
  }

  dropzoneEl.addEventListener("click", () => fileInputEl.click());
  dropzoneEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputEl.click();
    }
  });
  dropzoneEl.addEventListener("dragover", (event) => event.preventDefault());
  dropzoneEl.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files) intake(event.dataTransfer.files);
  });
  fileInputEl.addEventListener("change", () => {
    if (fileInputEl.files) intake(fileInputEl.files);
    fileInputEl.value = "";
  });

  // --- Rendering ---------------------------------------------------------
  // Each job's output filename is reserved against `outputNames` exactly
  // ONCE — `renderRows()` runs on every queue change (every progress tick,
  // not just on success), so recomputing via the shared collision tracker
  // on every render would keep reserving a new name for the SAME job.
  const resolvedOutputNames = new Map<string, string>();
  function jobOutputFilename(job: BatchJob): string {
    const existing = resolvedOutputNames.get(job.id);
    if (existing) return existing;
    const name = buildOutputFilename(job.displayName, adapter.outputExtension, outputNames);
    resolvedOutputNames.set(job.id, name);
    return name;
  }

  function jobDownloadUrl(job: BatchJob): string | null {
    if (!job.outputBytes) return null;
    return resultStore.getOrCreateUrl(job.id, job.outputBytes, outputMimeType(adapter.outputExtension));
  }

  /**
   * `renderRows()` clears and rebuilds every row on every queue change
   * (a progress tick, not just add/remove) — without this, focus is
   * silently dropped to `<body>` after literally any button click,
   * since the button the user just focused no longer exists once its
   * row is torn down and recreated. Captures which job/action had focus
   * before the rebuild, then restores it (or a sensible fallback) after.
   */
  function captureFocus(): { jobId: string; action: string } | null {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement) || !rowsContainerEl.contains(active)) return null;
    const row = active.closest<HTMLElement>(".batch-file-row");
    const jobId = row?.dataset.jobId;
    const action = active.getAttribute("data-row-action");
    return jobId && action ? { jobId, action } : null;
  }

  function restoreFocus(previous: { jobId: string; action: string } | null): void {
    if (!previous) return;
    const row = rowsContainerEl.querySelector<HTMLElement>(`[data-job-id="${previous.jobId}"]`);
    const sameAction = row?.querySelector<HTMLElement>(`[data-row-action="${previous.action}"]`);
    if (sameAction && !(sameAction as HTMLButtonElement).hidden) {
      sameAction.focus();
      return;
    }
    // The job (or that specific action) is gone — e.g. it was just
    // removed, or moved to a state where "cancel" is no longer offered.
    // Fall back to the first available action on the SAME row if it
    // still exists, else the dropzone (never leave focus on `<body>`).
    const firstActionOnRow = row?.querySelector<HTMLButtonElement>("[data-row-action]:not([hidden])");
    (firstActionOnRow ?? dropzoneEl).focus();
  }

  function renderRows(): void {
    const focused = captureFocus();
    const jobs = queue.getJobs();
    rowsContainerEl.innerHTML = "";
    for (const job of jobs) {
      const fragment = rowTemplateEl.content.cloneNode(true) as DocumentFragment;
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

      retryBtn.addEventListener("click", () => queue.retry(job.id));
      cancelBtn.addEventListener("click", () => queue.cancel(job.id));
      removeBtn.addEventListener("click", () => {
        resultStore.revoke(job.id);
        resolvedOutputNames.delete(job.id);
        queue.removeJob(job.id);
      });

      rowsContainerEl.appendChild(fragment);
    }
    restoreFocus(focused);
  }

  function renderSummary(): void {
    const jobs = queue.getJobs();
    const succeeded = jobs.filter((j) => j.state === "succeeded").length;
    const failed = jobs.filter((j) => j.state === "failed").length;
    summaryEl.textContent = jobs.length === 0 ? "No files added yet." : `${jobs.length} file(s) — ${succeeded} succeeded, ${failed} failed.`;
    if (downloadZipButton) downloadZipButton.disabled = succeeded === 0;
    if (downloadReportButton) downloadReportButton.disabled = jobs.length === 0;
  }

  function render(): void {
    renderRows();
    renderSummary();
    renderConcurrencyStatus();
  }
  render();
  queue.subscribe(render);

  // --- Batch-level controls ---------------------------------------------------------
  cancelAllButton?.addEventListener("click", () => queue.cancelAll());
  clearCompletedButton?.addEventListener("click", () => {
    for (const job of queue.getJobs()) {
      if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
        resultStore.revoke(job.id);
        resolvedOutputNames.delete(job.id);
      }
    }
    queue.clearCompleted();
  });

  downloadZipButton?.addEventListener("click", () => {
    const jobs = queue.getJobs();
    const zipTracker = new FilenameCollisionTracker();
    const entries = jobs.map((job) => ({
      jobId: job.id,
      outputFilename: buildOutputFilename(job.displayName, adapter.outputExtension, zipTracker),
      outputBytes: job.outputBytes,
      reportJson: JSON.stringify({ id: job.id, name: job.displayName, state: job.state, resultMeta: sanitizeJobResultMetaForReport(operationId, job.resultMeta) }),
      state: job.state,
    }));
    const summaryReport = buildDownloadableBatchReport(jobs, operationId, adapter.defaultSettings, "generated");
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
      // Ceiling exceeded or generation failed — the button stays enabled so the
      // user can still clear some completed jobs and try again; nothing crashes.
    }
  });

  downloadReportButton?.addEventListener("click", () => {
    const report = buildDownloadableBatchReport(queue.getJobs(), operationId, adapter.defaultSettings, "not-generated");
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "batch-report.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  // --- Teardown ---------------------------------------------------------
  window.addEventListener("pagehide", () => {
    scheduler.dispose();
    queue.dispose();
    resultStore.dispose();
    entitlementStore.dispose();
  });
}
