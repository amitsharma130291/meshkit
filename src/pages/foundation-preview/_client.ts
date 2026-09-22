/**
 * Orchestration for the /foundation-preview/ demo page. Wires the DOM
 * scaffolding rendered by ToolLayout + the tools/* components to the
 * actual foundation modules (file validation, worker protocol, WASM
 * loader, Three.js viewport, capability detection) so the page can prove
 * the whole pipeline works end to end. This file is intentionally
 * page-specific glue, not a reusable library module — a real tool page
 * will replace it with its own client script that calls the same lib/*
 * building blocks.
 *
 * Everything lives inside `init()`, called only when `document` exists.
 * Astro's static build imports client scripts into its server module
 * graph to resolve their bundled asset URLs, so any top-level DOM access
 * in this file would otherwise throw "document is not defined" in Node
 * during `astro build` — it must never run until the browser executes it.
 */
import { siteConfig } from "../../config/site";
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { loadWasmModule } from "../../lib/wasm/wasm-loader";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";

const MAX_SIZE_BYTES = 200 * 1024 * 1024;

function init(): void {
  const fileInput = document.querySelector<HTMLInputElement>("[data-file-input]")!;
  const fileMessage = document.querySelector<HTMLElement>("[data-file-message]")!;
  const runButton = document.querySelector<HTMLButtonElement>('[data-action="run"]')!;
  const cancelButton = document.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
  const resetButton = document.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
  const statusLabel = document.querySelector<HTMLElement>("[data-tool-status-label]")!;
  const progressWrap = document.querySelector<HTMLElement>("[data-tool-status-progress]")!;
  const progressBar = document.querySelector<HTMLElement>("[data-tool-status-bar]")!;
  const errorBox = document.querySelector<HTMLElement>("[data-tool-error]")!;
  const errorMessage = document.querySelector<HTMLElement>("[data-tool-error-message]")!;
  const errorGuidance = document.querySelector<HTMLElement>("[data-tool-error-guidance]")!;
  const viewportContainer = document.querySelector<HTMLElement>("[data-tool-viewport]")!;
  const resultsEl = document.querySelector<HTMLElement>("[data-results]")!;
  const resultName = document.querySelector<HTMLElement>("[data-result-name]")!;
  const resultBytes = document.querySelector<HTMLElement>("[data-result-bytes]")!;
  const resultChecksum = document.querySelector<HTMLElement>("[data-result-checksum]")!;
  const diagCapabilities = document.querySelector<HTMLElement>('[data-diagnostic="capabilities"]')!;
  const diagWorker = document.querySelector<HTMLElement>('[data-diagnostic="worker"]')!;
  const diagWasm = document.querySelector<HTMLElement>('[data-diagnostic="wasm"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let viewportTeardown: (() => void) | null = null;

  function setState(state: ToolState): void {
    statusLabel.textContent = TOOL_STATE_LABELS[state];
    progressWrap.hidden = state !== "processing" && state !== "initializing";
    runButton.disabled = state === "processing" || state === "initializing" || !currentSession || !workerReady;
    cancelButton.disabled = state !== "processing";
  }

  function showError(error: SafeError): void {
    errorMessage.textContent = error.message;
    errorGuidance.textContent = error.recoverable ? "You can try again." : "";
    errorBox.hidden = false;
  }

  function hideError(): void {
    errorBox.hidden = true;
    errorMessage.textContent = "";
    errorGuidance.textContent = "";
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function resetResultsUI(): void {
    resultsEl.hidden = true;
    resultName.textContent = "";
    resultBytes.textContent = "";
    resultChecksum.textContent = "";
    progressBar.style.width = "0%";
    hideError();
  }

  function disposeSession(): void {
    currentSession?.dispose();
    currentSession = null;
  }

  function createFoundationWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/foundation.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  }

  async function initWorker(): Promise<void> {
    diagWorker.textContent = "Worker: starting…";
    workerReady = false;

    workerClient = new WorkerClient(createFoundationWorker, {
      onReady: () => {
        workerReady = true;
        diagWorker.textContent = "Worker: ready";
        setState(currentSession ? "file-selected" : "idle");
      },
      onProgress: (_stage, completed, total) => {
        setState("processing");
        if (total) {
          const pct = Math.min(100, Math.round((completed / total) * 100));
          progressBar.style.width = `${pct}%`;
        }
      },
      onResult: (result) => {
        const r = result as { fileName: string; byteLength: number; foundationChecksum: number };
        resultName.textContent = r.fileName;
        resultBytes.textContent = formatBytes(r.byteLength);
        resultChecksum.textContent = String(r.foundationChecksum);
        resultsEl.hidden = false;
        setState("success");
      },
      onError: (error) => {
        showError(error);
        setState("error");
      },
      onCancelled: () => {
        setState("cancelled");
      },
    });

    try {
      workerClient.initialize();
    } catch {
      diagWorker.textContent = "Worker: failed to start";
      showError({
        code: "WORKER_INIT_FAILED",
        message: "The local processing engine couldn't start.",
        recoverable: false,
      });
    }
  }

  async function runWasmCheck(): Promise<void> {
    diagWasm.textContent = "WebAssembly: loading fixture…";
    try {
      const handle = await loadWasmModule("/wasm/foundation.wasm");
      const add = handle.exports.add as ((a: number, b: number) => number) | undefined;
      const sum = add?.(2, 3);
      diagWasm.textContent =
        sum === 5
          ? "WebAssembly: ready (foundation.wasm loaded, add(2, 3) = 5)"
          : "WebAssembly: loaded but returned an unexpected result";
    } catch (error) {
      diagWasm.textContent = isSafeError(error) ? `WebAssembly: ${error.message}` : "WebAssembly: failed to load";
    }
  }

  async function initViewport(): Promise<void> {
    const [{ ToolViewport }, THREE] = await Promise.all([import("../../lib/three/viewport"), import("three")]);

    let viewport: InstanceType<typeof ToolViewport>;
    try {
      viewport = new ToolViewport({
        container: viewportContainer,
        onContextLost: (error) => showError(error),
      });
    } catch (error) {
      if (isSafeError(error)) showError(error);
      return;
    }

    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, wireframe: true });
    const mesh = new THREE.Mesh(geometry, material);
    viewport.scene.add(mesh);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let rafHandle: number | null = null;

    const spin = (): void => {
      mesh.rotation.y += 0.01;
      mesh.rotation.x += 0.004;
      viewport.requestRender();
      rafHandle = requestAnimationFrame(spin);
    };

    if (reduceMotion) {
      viewport.requestRender();
    } else {
      rafHandle = requestAnimationFrame(spin);
    }

    const handleVisibility = (): void => {
      const visible = document.visibilityState === "visible";
      viewport.setVisible(visible);
      if (!visible && rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      } else if (visible && !reduceMotion && rafHandle === null) {
        rafHandle = requestAnimationFrame(spin);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    viewportTeardown = () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      viewport.dispose();
    };
  }

  fileInput.addEventListener("change", () => {
    resetResultsUI();
    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = {
      allowedExtensions: siteConfig.launchFormats as FileValidationConfig["allowedExtensions"],
      maxSizeBytes: MAX_SIZE_BYTES,
    };
    const result = validateSelectedFile(file, config);

    if (!result.valid) {
      fileMessage.textContent = result.error.message;
      fileMessage.dataset.state = "error";
      disposeSession();
      setState("idle");
      return;
    }

    disposeSession();
    currentSession = new FileSession(file, result.extension);
    currentSession.registerCleanup(() => workerClient?.cancel());
    fileMessage.textContent = `${file.name} selected (${formatBytes(file.size)}). Ready to run the foundation test.`;
    fileMessage.dataset.state = "success";
    setState("file-selected");
  });

  runButton.addEventListener("click", async () => {
    if (!currentSession || !workerClient) return;
    hideError();
    setState("initializing");
    try {
      const buffer = await currentSession.readArrayBuffer();
      setState("processing");
      workerClient.process(currentSession.file.name, currentSession.extension, buffer, {});
    } catch (error) {
      if (isSafeError(error)) showError(error);
      setState("error");
    }
  });

  cancelButton.addEventListener("click", () => {
    workerClient?.cancel();
  });

  resetButton.addEventListener("click", async () => {
    disposeSession();
    workerClient?.dispose();
    viewportTeardown?.();
    viewportTeardown = null;
    workerReady = false;

    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    resetResultsUI();
    diagWorker.textContent = "Worker: restarting…";
    diagWasm.textContent = "WebAssembly: restarting…";
    setState("idle");

    await Promise.all([initWorker(), runWasmCheck(), initViewport()]);
  });

  async function boot(): Promise<void> {
    const report = getCapabilityReport();

    if (!report.ready) {
      diagCapabilities.textContent = `Browser capabilities: missing ${report.missingRequired.join(", ")}`;
      fileInput.disabled = true;
      setState("unsupported");
      showError({
        code: "UNSUPPORTED_BROWSER",
        message: report.recoveryMessages[0] ?? "Your browser is missing capabilities this foundation test needs.",
        recoverable: false,
      });
      return;
    }

    diagCapabilities.textContent = "Browser capabilities: all required features available";
    setState("idle");
    await Promise.all([initWorker(), runWasmCheck(), initViewport()]);
  }

  void boot();
}

if (typeof document !== "undefined") {
  init();
}
