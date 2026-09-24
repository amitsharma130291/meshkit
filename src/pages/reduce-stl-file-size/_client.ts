/**
 * Orchestration for STL Optimization — the SHARED implementation behind
 * `/reduce-stl-file-size/` (primary), `/simplify-stl/` and
 * `/stl-triangle-reducer/` (secondary SEO routes). Every route's own
 * `<script>` tag imports this exact module rather than duplicating any
 * of it — one optimization engine, three SEO-differentiated pages
 * around it (see `docs/ARCHITECTURE.md`'s "STL Optimization (Phase 8)"
 * section for why a fourth candidate route, `/stl-mesh-optimizer/`, was
 * deliberately NOT built).
 *
 * Same single-persistent-worker pattern as `stl-repair/_client.ts` (this
 * page only ever handles one format, so there's no format-switch concern
 * for a rebound worker callback to go stale against), and the same
 * two-phase `mode: "plan"` / `mode: "optimize"` workflow — optimization
 * only ever runs after a SEPARATE, explicit "Run optimization" click.
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { sanitizeDownloadBasename, buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize, formatTriangleCount } from "../../lib/stl/format";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { DEFAULT_OPTIMIZE_LIMITS, type OptimizeResult, type OptimizeSettings, type QualityPresetName } from "../../lib/mesh-optimization/types";
import type { OptimizePlan } from "../../lib/mesh-optimization/plan";
import { buildDownloadableOptimizeReport } from "../../lib/mesh-optimization/report";
import { formatEligibility, formatMagnitude, formatOutcome, formatPercent } from "../../lib/mesh-optimization/formatting";
import { initBatchOptimizePlanClient } from "../../lib/pro/batch-optimize-plan-client";
import { createProductionEntitlementProvider } from "../../lib/pro/production-provider";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 150 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  "reading-stl": "Reading STL…",
  "checking-source-mesh": "Checking source mesh…",
  "building-indexed-topology": "Building indexed topology…",
  "building-collapse-candidates": "Building collapse candidates…",
  "simplifying-mesh": "Simplifying mesh…",
  "writing-optimized-stl": "Writing optimized STL…",
  "verifying-optimized-stl": "Verifying optimized STL…",
  "measuring-deviation": "Measuring deviation…",
  "preparing-comparison": "Preparing comparison…",
  ready: "Finishing up…",
};

type WorkerResultPayload = { mode: "plan"; plan: OptimizePlan } | { mode: "optimize"; optimize: OptimizeResult };

function init(): void {
  const fileInput = document.querySelector<HTMLInputElement>("[data-file-input]")!;
  const fileMessage = document.querySelector<HTMLElement>("[data-file-message]")!;
  const cancelButton = document.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
  const statusLabel = document.querySelector<HTMLElement>("[data-tool-status-label]")!;
  const progressWrap = document.querySelector<HTMLElement>("[data-tool-status-progress]")!;
  const errorBox = document.querySelector<HTMLElement>("[data-tool-error]")!;
  const errorMessage = document.querySelector<HTMLElement>("[data-tool-error-message]")!;
  const errorGuidance = document.querySelector<HTMLElement>("[data-tool-error-guidance]")!;
  const viewportContainer = document.querySelector<HTMLElement>("[data-tool-viewport]")!;
  const viewportDescriptionId = viewportContainer.querySelector("[data-tool-viewport-description]")?.id;
  const successConfirmation = document.querySelector<HTMLElement>("[data-success-confirmation]")!;

  const targetPresetRadios = document.querySelectorAll<HTMLInputElement>('input[name="target-preset"]');
  const customTargetField = document.querySelector<HTMLElement>("[data-custom-target-field]")!;
  const customTargetInput = document.querySelector<HTMLInputElement>('[data-action="custom-target-count"]')!;
  const resolvedTargetNote = document.querySelector<HTMLElement>("[data-resolved-target-note]")!;
  const qualityPresetRadios = document.querySelectorAll<HTMLInputElement>('input[name="quality-preset"]');
  const analyzeButton = document.querySelector<HTMLButtonElement>('[data-action="analyze-optimize-plan"]')!;

  const planPanel = document.querySelector<HTMLElement>("[data-optimize-plan]")!;
  const eligibilityBadge = document.querySelector<HTMLElement>("[data-eligibility-badge]")!;
  const planReasonsList = document.querySelector<HTMLElement>("[data-plan-reasons]")!;
  const planTargetSummary = document.querySelector<HTMLElement>("[data-plan-target-summary]")!;
  const runOptimizeButton = document.querySelector<HTMLButtonElement>('[data-action="run-optimize"]')!;

  const resultPanel = document.querySelector<HTMLElement>("[data-optimize-result]")!;
  const outcomeBadge = document.querySelector<HTMLElement>("[data-outcome-badge]")!;
  const outcomeLabel = document.querySelector<HTMLElement>("[data-outcome-label]")!;
  const unresolvedList = document.querySelector<HTMLElement>("[data-unresolved-list]")!;
  const unresolvedNone = document.querySelector<HTMLElement>("[data-unresolved-none]")!;
  const optimizeWarnings = document.querySelector<HTMLElement>("[data-optimize-warnings]")!;
  const downloadStlButton = document.querySelector<HTMLButtonElement>('[data-action="download-optimized-stl"]')!;
  const downloadReportButton = document.querySelector<HTMLButtonElement>('[data-action="download-optimize-report"]')!;

  const comparisonPanel = document.querySelector<HTMLElement>("[data-optimize-comparison]")!;

  const showOriginalButton = document.querySelector<HTMLButtonElement>('[data-action="show-original"]')!;
  const showOptimizedButton = document.querySelector<HTMLButtonElement>('[data-action="show-optimized"]')!;
  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitModelButton = document.querySelector<HTMLButtonElement>('[data-action="fit-model"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;

  const batchWorkspaceRoot = document.querySelector<HTMLElement>("[data-batch-workspace]");
  if (batchWorkspaceRoot) initBatchOptimizePlanClient(batchWorkspaceRoot, createProductionEntitlementProvider());

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastRadius: number | null = null;
  let lastOptimizeResult: OptimizeResult | null = null;
  let lastSourceTriangleCount = 0;
  let showingOptimized = false;
  let currentWireframe = false;
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let dampingActive = false;
  let dampingStopTimer: number | null = null;

  let currentMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let currentGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let originalPositions: Float32Array | null = null;
  let originalNormals: Float32Array | null = null;
  let optimizedPositions: Float32Array | null = null;
  let optimizedNormals: Float32Array | null = null;

  let gridHelper: InstanceType<ThreeModule["GridHelper"]> | null = null;
  let axesHelper: InstanceType<ThreeModule["AxesHelper"]> | null = null;

  function setState(state: ToolState): void {
    statusLabel.textContent = TOOL_STATE_LABELS[state];
    progressWrap.hidden = state !== "processing" && state !== "initializing";
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

  function disposeSession(): void {
    currentSession?.dispose();
    currentSession = null;
  }

  function disposeCurrentModel(): void {
    if (currentMesh && viewport) viewport.scene.remove(currentMesh);
    currentGeometry?.dispose();
    currentMaterial?.dispose();
    currentMesh = null;
    currentGeometry = null;
    currentMaterial = null;
  }

  function stopDampingLoop(): void {
    dampingActive = false;
    if (dampingStopTimer !== null) {
      window.clearTimeout(dampingStopTimer);
      dampingStopTimer = null;
    }
  }

  function disposeViewer(): void {
    stopDampingLoop();
    disposeCurrentModel();
    orbitControls?.dispose();
    orbitControls = null;
    viewport?.dispose();
    viewport = null;
  }

  async function ensureViewer(): Promise<void> {
    if (viewport && orbitControls && THREE) return;
    const [threeModule, { ToolViewport }, { OrbitControls }] = await Promise.all([
      import("three"),
      import("../../lib/three/viewport"),
      import("three/examples/jsm/controls/OrbitControls.js"),
    ]);
    THREE = threeModule;

    viewport = new ToolViewport({
      container: viewportContainer,
      preserveDrawingBuffer: true,
      onContextLost: (error) => {
        showError(error);
        setState("error");
      },
    });
    if (viewportDescriptionId) viewport.canvas.setAttribute("aria-describedby", viewportDescriptionId);
    viewport.canvas.tabIndex = 0;

    orbitControls = new OrbitControls(viewport.camera, viewport.canvas);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.enablePan = true;
    orbitControls.screenSpacePanning = true;
    orbitControls.listenToKeyEvents(window);

    const tick = (): void => {
      orbitControls?.update();
      viewport?.requestRender();
      if (dampingActive) requestAnimationFrame(tick);
    };
    orbitControls.addEventListener("start", () => {
      if (dampingStopTimer !== null) {
        window.clearTimeout(dampingStopTimer);
        dampingStopTimer = null;
      }
      if (!dampingActive) {
        dampingActive = true;
        requestAnimationFrame(tick);
      }
    });
    orbitControls.addEventListener("end", () => {
      dampingStopTimer = window.setTimeout(() => {
        dampingActive = false;
      }, 500);
    });
    orbitControls.addEventListener("change", () => {
      if (!dampingActive) viewport?.requestRender();
    });
  }

  function fitCameraAndControls(radius: number): void {
    if (!viewport || !orbitControls || !THREE) return;
    stopDampingLoop();
    const wasDamping = orbitControls.enableDamping;
    orbitControls.enableDamping = false;
    orbitControls.update();
    orbitControls.enableDamping = wasDamping;

    const safeRadius = Math.max(radius, 1e-6);
    const camera = viewport.camera;
    const fovRad = (camera.fov * Math.PI) / 180;
    const distance = (safeRadius / Math.sin(fovRad / 2)) * 1.35;
    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    camera.position.copy(direction.multiplyScalar(distance));
    camera.near = Math.max(distance / 1000, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    orbitControls.target.set(0, 0, 0);
    orbitControls.minDistance = safeRadius * 0.4;
    orbitControls.maxDistance = safeRadius * 12;
    orbitControls.update();
    viewport.requestRender();
  }

  function buildMesh(positions: Float32Array, normals: Float32Array): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();

    const material = new THREE.MeshStandardMaterial({ color: "#c7c2de", metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: currentWireframe });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
    viewport.scene.add(mesh);

    currentMesh = mesh;
    currentGeometry = geometry;
    currentMaterial = material;
    lastRadius = Math.max(sphere.radius, 1e-6);
  }

  // --- Plan + optimize request handling ------------------------------------

  function resolvedTargetPreview(): { mode: "percentage" | "triangle-count"; value: number } {
    const checked = document.querySelector<HTMLInputElement>('input[name="target-preset"]:checked')?.value ?? "50";
    if (checked === "custom") {
      const value = customTargetInput.value ? Number(customTargetInput.value) : Math.max(1, Math.round(lastSourceTriangleCount / 2));
      return { mode: "triangle-count", value };
    }
    return { mode: "percentage", value: Number(checked) };
  }

  function currentSettings(): OptimizeSettings {
    const preset = (document.querySelector<HTMLInputElement>('input[name="quality-preset"]:checked')?.value ?? "balanced") as QualityPresetName;
    return { target: resolvedTargetPreview(), preset };
  }

  function renderPlan(plan: OptimizePlan): void {
    lastSourceTriangleCount = plan.before.triangleCount;
    eligibilityBadge.dataset.eligibility = plan.eligibility;
    eligibilityBadge.textContent = formatEligibility(plan.eligibility);

    planReasonsList.textContent = "";
    for (const reason of plan.reasons) {
      const li = document.createElement("li");
      li.textContent = reason;
      planReasonsList.appendChild(li);
    }

    const eligible = plan.eligibility === "eligible" || plan.eligibility === "eligible-with-warnings";
    planTargetSummary.textContent = eligible
      ? `Source: ${formatTriangleCount(plan.before.triangleCount)} triangles. Resolved target: ${formatTriangleCount(plan.requestedTargetTriangleCount)} triangles.`
      : "This file isn't eligible for automatic simplification — see the reasons above.";
    resolvedTargetNote.textContent = `Resolved target: ${formatTriangleCount(plan.requestedTargetTriangleCount)} triangles`;

    const thresholdsNote = document.querySelector<HTMLElement>("[data-plan-thresholds-note]");
    if (thresholdsNote) {
      thresholdsNote.textContent = `This preset's own quality-policy limits: surface area change up to ${plan.appliedThresholds.maxSurfaceAreaChangePercent}%, closed-shell volume change up to ${plan.appliedThresholds.maxVolumeChangePercent}% (when volume is measurable). Not a manufacturing tolerance.`;
    }

    planPanel.hidden = false;
    runOptimizeButton.disabled = !eligible;
  }

  function renderOptimizeResult(result: OptimizeResult): void {
    lastOptimizeResult = result;
    outcomeBadge.dataset.outcome = result.outcome;
    outcomeLabel.textContent = formatOutcome(result.outcome);

    const set = (selector: string, text: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) el.textContent = text;
    };
    set("[data-requested-reduction]", formatPercent(result.requestedReductionPercent));
    set("[data-achieved-reduction]", formatPercent(result.achievedReductionPercent));
    set("[data-original-triangles]", formatTriangleCount(result.originalTriangleCount));
    set("[data-optimized-triangles]", formatTriangleCount(result.optimizedTriangleCount));
    set("[data-original-bytes]", formatFileSize(result.originalBytes));
    set("[data-optimized-bytes]", result.optimizedBytes !== null ? formatFileSize(result.optimizedBytes) : "—");
    set("[data-bytes-saved]", result.actualBytesSaved !== null ? formatFileSize(result.actualBytesSaved) : "—");
    set("[data-stop-reason]", result.stopReason);

    if (result.deviation) {
      set("[data-deviation-max]", result.deviation.maxDeviation.toFixed(6));
      set("[data-deviation-mean]", result.deviation.meanDeviation.toFixed(6));
      set("[data-deviation-rms]", result.deviation.rmsDeviation.toFixed(6));
      set("[data-deviation-samples]", formatTriangleCount(result.deviation.sampleCount));
      const incompleteNote = document.querySelector<HTMLElement>("[data-deviation-incomplete-note]")!;
      incompleteNote.hidden = result.deviation.completed;
    }

    set("[data-surface-area-before]", formatMagnitude(result.surfaceAreaBefore));
    set("[data-surface-area-after]", formatMagnitude(result.surfaceAreaAfter));
    set("[data-surface-area-change]", result.surfaceAreaChangePercent !== null ? formatPercent(result.surfaceAreaChangePercent) : "—");

    const volumeUnavailableNote = document.querySelector<HTMLElement>("[data-volume-unavailable-note]")!;
    if (result.volumeStatus === "completed") {
      set("[data-volume-before]", formatMagnitude(result.volumeBefore!));
      set("[data-volume-after]", formatMagnitude(result.volumeAfter!));
      set("[data-volume-change]", result.volumeChangePercent !== null ? formatPercent(result.volumeChangePercent) : "—");
      volumeUnavailableNote.hidden = true;
    } else {
      set("[data-volume-before]", "—");
      set("[data-volume-after]", "—");
      set("[data-volume-change]", "—");
      volumeUnavailableNote.textContent = result.volumeReason ?? "Volume isn't meaningful for this geometry.";
      volumeUnavailableNote.hidden = false;
    }

    const thresholdNote = document.querySelector<HTMLElement>("[data-threshold-note]")!;
    if (result.thresholdCheck.reason) {
      thresholdNote.textContent = `This result exceeded this preset's own quality-policy limits (surface area ${result.appliedThresholds.maxSurfaceAreaChangePercent}% / volume ${result.appliedThresholds.maxVolumeChangePercent}%): ${result.thresholdCheck.reason}.`;
      thresholdNote.hidden = false;
    } else {
      thresholdNote.hidden = true;
    }

    unresolvedList.textContent = "";
    if (result.unresolvedProblems.length === 0) {
      unresolvedNone.hidden = false;
    } else {
      unresolvedNone.hidden = true;
      for (const problem of result.unresolvedProblems) {
        const li = document.createElement("li");
        li.textContent = problem;
        unresolvedList.appendChild(li);
      }
    }

    optimizeWarnings.textContent = "";
    if (result.warnings.length > 0) {
      const ul = document.createElement("ul");
      for (const w of result.warnings) {
        const li = document.createElement("li");
        li.textContent = w;
        ul.appendChild(li);
      }
      optimizeWarnings.appendChild(ul);
      optimizeWarnings.hidden = false;
    } else {
      optimizeWarnings.hidden = true;
    }

    const setCompare = (selector: string, text: string) => {
      const el = comparisonPanel.querySelector<HTMLElement>(selector);
      if (el) el.textContent = text;
    };
    setCompare("[data-compare-verdict-before]", result.before.verdict);
    setCompare("[data-compare-verdict-after]", result.after?.verdict ?? "—");
    setCompare("[data-compare-triangles-before]", formatTriangleCount(result.before.triangleCount));
    setCompare("[data-compare-triangles-after]", result.after ? formatTriangleCount(result.after.triangleCount) : "—");
    setCompare("[data-compare-vertices-before]", formatTriangleCount(result.before.uniqueVertexPositionCount));
    setCompare("[data-compare-vertices-after]", result.after ? formatTriangleCount(result.after.uniqueVertexPositionCount) : "—");
    setCompare("[data-compare-shells-before]", formatTriangleCount(result.shellCountBefore));
    setCompare("[data-compare-shells-after]", result.shellCountAfter !== null ? formatTriangleCount(result.shellCountAfter) : "—");
    setCompare("[data-compare-boundary-before]", formatTriangleCount(result.boundaryEdgesBefore));
    setCompare("[data-compare-boundary-after]", result.boundaryEdgesAfter !== null ? formatTriangleCount(result.boundaryEdgesAfter) : "—");
    setCompare("[data-compare-nonmanifold-before]", formatTriangleCount(result.nonManifoldEdgesBefore));
    setCompare("[data-compare-nonmanifold-after]", result.nonManifoldEdgesAfter !== null ? formatTriangleCount(result.nonManifoldEdgesAfter) : "—");

    resultPanel.hidden = false;
    comparisonPanel.hidden = false;
    downloadStlButton.disabled = !result.outputBytes;
    downloadReportButton.disabled = !result.outputBytes;
    showOptimizedButton.disabled = !result.outputBytes;

    if (result.outputBytes && parseOptimizedSTLForDisplay(result.outputBytes)) {
      void ensureViewer();
    }
  }

  function parseOptimizedSTLForDisplay(bytes: ArrayBuffer): boolean {
    try {
      const view = new DataView(bytes);
      if (bytes.byteLength < 84) return false;
      const triangleCount = view.getUint32(80, true);
      const positions = new Float32Array(triangleCount * 9);
      const normals = new Float32Array(triangleCount * 9);
      let offset = 84;
      for (let t = 0; t < triangleCount; t++) {
        const nx = view.getFloat32(offset, true);
        const ny = view.getFloat32(offset + 4, true);
        const nz = view.getFloat32(offset + 8, true);
        let vOff = offset + 12;
        for (let v = 0; v < 3; v++) {
          const base = t * 9 + v * 3;
          positions[base] = view.getFloat32(vOff, true);
          positions[base + 1] = view.getFloat32(vOff + 4, true);
          positions[base + 2] = view.getFloat32(vOff + 8, true);
          normals[base] = nx;
          normals[base + 1] = ny;
          normals[base + 2] = nz;
          vOff += 12;
        }
        offset += 50;
      }
      optimizedPositions = positions;
      optimizedNormals = normals;
      return true;
    } catch {
      return false;
    }
  }

  function showModel(which: "original" | "optimized"): void {
    if (!viewport) return;
    showingOptimized = which === "optimized";
    showOriginalButton.setAttribute("aria-pressed", String(!showingOptimized));
    showOptimizedButton.setAttribute("aria-pressed", String(showingOptimized));
    const positions = showingOptimized ? optimizedPositions : originalPositions;
    const normals = showingOptimized ? optimizedNormals : originalNormals;
    if (!positions || !normals) return;
    buildMesh(positions, normals);
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  }

  // --- Worker lifecycle ------------------------------------------------

  function createOptimizeWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/stl-optimizer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  }

  async function requestPlan(): Promise<void> {
    if (!currentSession || !workerClient || !workerReady) return;
    hideError();
    setState("processing");
    try {
      const buffer = await currentSession.readArrayBuffer();
      workerClient.process(currentSession.file.name, currentSession.extension, buffer, { mode: "plan", settings: currentSettings() });
    } catch (error) {
      if (isSafeError(error)) showError(error);
      setState("error");
    }
  }

  async function requestOptimize(): Promise<void> {
    if (!currentSession || !workerClient || !workerReady) return;
    hideError();
    setState("processing");
    runOptimizeButton.disabled = true;
    try {
      const buffer = await currentSession.readArrayBuffer();
      workerClient.process(currentSession.file.name, currentSession.extension, buffer, { mode: "optimize", settings: currentSettings() });
    } catch (error) {
      if (isSafeError(error)) showError(error);
      setState("error");
    }
  }

  async function initWorker(): Promise<void> {
    workerReady = false;
    workerClient = new WorkerClient(createOptimizeWorker, {
      onReady: () => {
        workerReady = true;
        if (currentSession) void requestPlan();
      },
      onProgress: (stage) => {
        setState("processing");
        statusLabel.textContent = STAGE_LABELS[stage] ?? TOOL_STATE_LABELS.processing;
        cancelButton.hidden = false;
      },
      onResult: (raw) => {
        cancelButton.hidden = true;
        const payload = raw as WorkerResultPayload;
        if (payload.mode === "plan") {
          renderPlan(payload.plan);
        } else {
          renderOptimizeResult(payload.optimize);
        }
        setState("success");
        successConfirmation.hidden = false;
      },
      onError: (error) => {
        cancelButton.hidden = true;
        showError(error);
        setState("error");
      },
      onCancelled: () => {
        cancelButton.hidden = true;
        setState("cancelled");
      },
    });
    try {
      workerClient.initialize();
    } catch {
      showError({ code: "WORKER_INIT_FAILED", message: "The local processing engine couldn't start.", recoverable: false });
      setState("error");
    }
  }

  // --- Downloads + screenshot -------------------------------------------

  function downloadOptimizedStl(): void {
    if (!lastOptimizeResult?.outputBytes || !currentSession) return;
    const blob = new Blob([lastOptimizeResult.outputBytes], { type: "model/stl" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-optimized.stl`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadReport(): void {
    if (!lastOptimizeResult || !currentSession) return;
    const downloadable = buildDownloadableOptimizeReport(lastOptimizeResult, DEFAULT_OPTIMIZE_LIMITS, currentSession.file.name, currentSession.file.size);
    const json = JSON.stringify(downloadable, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-optimize-report.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function exportScreenshot(): Promise<void> {
    if (!viewport || !currentSession) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => viewport!.canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("empty blob");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = buildScreenshotFilename(currentSession.file.name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      showError({ code: "UNKNOWN_ERROR", message: "Couldn't generate a screenshot. Try again.", recoverable: true });
    }
  }

  // --- Wiring ------------------------------------------------------------

  function clearFile(): void {
    disposeSession();
    disposeCurrentModel();
    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    hideError();
    successConfirmation.hidden = true;
    planPanel.hidden = true;
    resultPanel.hidden = true;
    comparisonPanel.hidden = true;
    cancelButton.hidden = true;
    lastRadius = null;
    lastOptimizeResult = null;
    lastSourceTriangleCount = 0;
    originalPositions = null;
    originalNormals = null;
    optimizedPositions = null;
    optimizedNormals = null;
    runOptimizeButton.disabled = true;
    downloadStlButton.disabled = true;
    downloadReportButton.disabled = true;
    showOptimizedButton.disabled = true;
    showModelReset();
    setState("idle");
  }

  function showModelReset(): void {
    showingOptimized = false;
    showOriginalButton.setAttribute("aria-pressed", "true");
    showOptimizedButton.setAttribute("aria-pressed", "false");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    successConfirmation.hidden = true;
    planPanel.hidden = true;
    resultPanel.hidden = true;
    comparisonPanel.hidden = true;

    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = { allowedExtensions: ["stl"], maxSizeBytes: MAX_SIZE_BYTES };
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
    fileMessage.textContent = `${file.name} selected (${formatFileSize(file.size)}).`;
    fileMessage.dataset.state = "success";
    setState("file-selected");

    void (async () => {
      await ensureViewer();
      const buffer = await file.arrayBuffer();
      if (parseOriginalSTLForDisplay(buffer)) {
        if (originalPositions && originalNormals) buildMesh(originalPositions, originalNormals);
        if (lastRadius !== null) fitCameraAndControls(lastRadius);
      }
      void requestPlan();
    })();
  });

  function parseOriginalSTLForDisplay(buffer: ArrayBuffer): boolean {
    try {
      const view = new DataView(buffer);
      if (buffer.byteLength < 84) return false;
      const triangleCount = view.getUint32(80, true);
      if (84 + triangleCount * 50 !== buffer.byteLength) return false;
      const positions = new Float32Array(triangleCount * 9);
      const normals = new Float32Array(triangleCount * 9);
      let offset = 84;
      for (let t = 0; t < triangleCount; t++) {
        const nx = view.getFloat32(offset, true);
        const ny = view.getFloat32(offset + 4, true);
        const nz = view.getFloat32(offset + 8, true);
        let vOff = offset + 12;
        for (let v = 0; v < 3; v++) {
          const base = t * 9 + v * 3;
          positions[base] = view.getFloat32(vOff, true);
          positions[base + 1] = view.getFloat32(vOff + 4, true);
          positions[base + 2] = view.getFloat32(vOff + 8, true);
          normals[base] = nx;
          normals[base + 1] = ny;
          normals[base + 2] = nz;
          vOff += 12;
        }
        offset += 50;
      }
      originalPositions = positions;
      originalNormals = normals;
      return true;
    } catch {
      return false;
    }
  }

  cancelButton.addEventListener("click", () => workerClient?.cancel());

  targetPresetRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      const isCustom = radio.value === "custom" && radio.checked;
      customTargetField.hidden = !isCustom;
      customTargetInput.disabled = !isCustom;
      planPanel.hidden = true;
      runOptimizeButton.disabled = true;
    });
  });
  customTargetInput.addEventListener("input", () => {
    planPanel.hidden = true;
    runOptimizeButton.disabled = true;
  });
  qualityPresetRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      planPanel.hidden = true;
      runOptimizeButton.disabled = true;
    });
  });

  analyzeButton.addEventListener("click", () => void requestPlan());
  runOptimizeButton.addEventListener("click", () => void requestOptimize());

  showOriginalButton.addEventListener("click", () => showModel("original"));
  showOptimizedButton.addEventListener("click", () => showModel("optimized"));
  resetCameraButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  fitModelButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  wireframeButton.addEventListener("click", () => {
    currentWireframe = !currentWireframe;
    wireframeButton.setAttribute("aria-pressed", String(currentWireframe));
    if (currentMaterial) currentMaterial.wireframe = currentWireframe;
    viewport?.requestRender();
  });
  gridButton.addEventListener("click", () => {
    gridVisible = !gridVisible;
    gridButton.setAttribute("aria-pressed", String(gridVisible));
    if (gridVisible && THREE && viewport && !gridHelper) {
      gridHelper = new THREE.GridHelper(10, 20);
      viewport.scene.add(gridHelper);
    }
    if (gridHelper) gridHelper.visible = gridVisible;
    viewport?.requestRender();
  });
  axesButton.addEventListener("click", () => {
    axesVisible = !axesVisible;
    axesButton.setAttribute("aria-pressed", String(axesVisible));
    if (axesVisible && THREE && viewport && !axesHelper) {
      axesHelper = new THREE.AxesHelper(2);
      viewport.scene.add(axesHelper);
    }
    if (axesHelper) axesHelper.visible = axesVisible;
    viewport?.requestRender();
  });

  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  screenshotButton.addEventListener("click", () => void exportScreenshot());
  downloadStlButton.addEventListener("click", downloadOptimizedStl);
  downloadReportButton.addEventListener("click", downloadReport);
  clearButton.addEventListener("click", clearFile);

  document.addEventListener("visibilitychange", () => {
    const isVisible = document.visibilityState === "visible";
    viewport?.setVisible(isVisible);
    if (!isVisible) stopDampingLoop();
  });

  window.addEventListener("pagehide", () => {
    disposeViewer();
    workerClient?.dispose();
    disposeSession();
  });

  async function boot(): Promise<void> {
    const report = getCapabilityReport();
    if (!report.ready) {
      fileInput.disabled = true;
      setState("unsupported");
      showError({ code: "UNSUPPORTED_BROWSER", message: `Your browser is missing a required feature: ${report.missingRequired.join(", ")}.`, recoverable: false });
      if (report.recoveryMessages.length > 0) errorGuidance.textContent = report.recoveryMessages.join(" ");
      return;
    }
    setState("idle");
    await initWorker();
  }

  void boot();
}

if (typeof document !== "undefined") {
  init();
}
