/**
 * Orchestration for /stl-viewer/. Wires the ToolLayout scaffolding to the
 * STL parser (via stl-viewer.worker.ts, run through the Phase 1 worker
 * protocol), a lazily-loaded Three.js viewport + OrbitControls, and the
 * viewer controls (reset camera, fit model, wireframe, color, background,
 * screenshot, clear). See src/pages/foundation-preview/_client.ts for the
 * pattern this follows, and docs/ARCHITECTURE.md for the full data flow.
 *
 * Everything lives inside `init()`, guarded to only run when `document`
 * exists — Astro's static build imports client scripts into its server
 * module graph to resolve bundled asset URLs (see the foundation-preview
 * client for the "document is not defined" pitfall this avoids).
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { buildScreenshotFilename } from "../../lib/files/download";
import {
  convertDimension,
  formatDimensionWithUnit,
  formatFileSize,
  formatMagnitude,
  formatTriangleCount,
  unitLabel,
  type STLDisplayUnit,
} from "../../lib/stl/format";
import type { STLBounds, STLEncoding } from "../../lib/stl/types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

interface STLWorkerResult {
  encoding: STLEncoding;
  triangleCount: number;
  positions: Float32Array;
  normals: Float32Array;
  bounds: STLBounds;
  header?: string;
}

const MAX_SIZE_BYTES = 100 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading file…",
  "detecting-format": "Detecting STL format…",
  parsing: "Parsing geometry…",
  "calculating-bounds": "Calculating bounds…",
  "preparing-model": "Preparing model…",
  complete: "Finishing up…",
};

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
  const modelInfo = document.querySelector<HTMLElement>("[data-model-info]")!;
  const infoFilesize = document.querySelector<HTMLElement>("[data-info-filesize]")!;
  const infoEncoding = document.querySelector<HTMLElement>("[data-info-encoding]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const infoBboxMin = document.querySelector<HTMLElement>("[data-info-bbox-min]")!;
  const infoBboxMax = document.querySelector<HTMLElement>("[data-info-bbox-max]")!;
  const unitSelect = document.querySelector<HTMLSelectElement>("[data-unit-select]")!;
  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitModelButton = document.querySelector<HTMLButtonElement>('[data-action="fit-model"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastBounds: STLBounds | null = null;
  let lastRadius: number | null = null;
  let currentUnit: STLDisplayUnit = "units";
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let currentMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let currentGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let dampingActive = false;
  // Typed as `number` (not `ReturnType<typeof window.setTimeout>`) because
  // @types/node's ambient `setTimeout` otherwise shadows the DOM overload
  // and would infer `NodeJS.Timeout`, which `window.setTimeout` never returns.
  let dampingStopTimer: number | null = null;

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
      preserveDrawingBuffer: true, // required for reliable canvas.toBlob() screenshot export
      onContextLost: (error) => {
        showError(error);
        setState("error");
      },
    });
    if (viewportDescriptionId) {
      viewport.canvas.setAttribute("aria-describedby", viewportDescriptionId);
    }
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

    // OrbitControls accumulates a "sphericalDelta" from recent drag/zoom
    // input and keeps re-applying a decaying fraction of it on every
    // `update()` call while damping is enabled — including the `update()`
    // call below. A real drag can leave a large residual that hasn't fully
    // decayed yet (the tick loop stops calling `update()` ~500ms after the
    // gesture ends, freezing whatever remains). Left uncleared, that
    // residual gets re-applied on top of the fit we're about to set,
    // silently pulling the camera back toward the pre-reset view. Doing one
    // `update()` with damping temporarily off zeroes it before we position
    // the camera for real.
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

  function buildMeshFromResult(result: STLWorkerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();

    const material = new THREE.MeshStandardMaterial({
      color: currentColorHex,
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      wireframe: currentWireframe,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
    viewport.scene.add(mesh);

    currentMesh = mesh;
    currentGeometry = geometry;
    currentMaterial = material;
    lastRadius = Math.max(sphere.radius, 1e-6);

    fitCameraAndControls(lastRadius);
  }

  function renderDimensions(bounds: STLBounds): void {
    infoWidth.textContent = formatDimensionWithUnit(bounds.size[0], currentUnit);
    infoHeight.textContent = formatDimensionWithUnit(bounds.size[1], currentUnit);
    infoDepth.textContent = formatDimensionWithUnit(bounds.size[2], currentUnit);
    infoBboxMin.textContent = formatTriplet(bounds.min);
    infoBboxMax.textContent = formatTriplet(bounds.max);
  }

  function formatTriplet(values: readonly [number, number, number]): string {
    const parts = values.map((value) => formatMagnitude(convertDimension(value, currentUnit)));
    return `(${parts.join(", ")}) ${unitLabel(currentUnit)}`;
  }

  async function renderResult(result: STLWorkerResult): Promise<void> {
    try {
      await ensureViewer();
      buildMeshFromResult(result);

      infoFilesize.textContent = formatFileSize(lastFileSize);
      infoEncoding.textContent = result.encoding === "binary" ? "Binary" : "ASCII";
      infoTriangles.textContent = formatTriangleCount(result.triangleCount);
      lastBounds = result.bounds;
      renderDimensions(result.bounds);

      modelInfo.hidden = false;
      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false });
      setState("error");
    }
  }

  function createSTLWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/stl-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  }

  async function startProcessing(): Promise<void> {
    if (!currentSession || !workerClient || !workerReady) return;
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
  }

  async function initWorker(): Promise<void> {
    workerReady = false;
    workerClient = new WorkerClient(createSTLWorker, {
      onReady: () => {
        workerReady = true;
        if (currentSession) void startProcessing();
      },
      onProgress: (stage) => {
        setState("processing");
        statusLabel.textContent = STAGE_LABELS[stage] ?? TOOL_STATE_LABELS.processing;
        cancelButton.hidden = false;
      },
      onResult: (result) => {
        cancelButton.hidden = true;
        void renderResult(result as STLWorkerResult);
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
      showError({
        code: "WORKER_INIT_FAILED",
        message: "The local processing engine couldn't start.",
        recoverable: false,
      });
      setState("error");
    }
  }

  async function exportScreenshot(): Promise<void> {
    if (!viewport || !currentSession) return;
    try {
      // No need to force a fresh render and wait on requestAnimationFrame
      // here: the viewport is created with `preserveDrawingBuffer: true`
      // specifically so the canvas always retains its last-rendered frame,
      // and every control that changes the view (rotate, wireframe, color,
      // fit/reset) already calls `requestRender()` itself. Waiting on rAF
      // here would also be unreliable while the tab is backgrounded, since
      // rendering is intentionally paused then (see the visibilitychange
      // handler below).
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

  function clearFile(): void {
    disposeSession();
    disposeCurrentModel();
    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    hideError();
    successConfirmation.hidden = true;
    modelInfo.hidden = true;
    cancelButton.hidden = true;
    lastBounds = null;
    lastRadius = null;
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    successConfirmation.hidden = true;
    modelInfo.hidden = true;

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
    lastFileSize = file.size;
    fileMessage.textContent = `${file.name} selected (${formatFileSize(file.size)}).`;
    fileMessage.dataset.state = "success";
    setState("file-selected");

    void startProcessing();
  });

  cancelButton.addEventListener("click", () => {
    workerClient?.cancel();
  });

  resetCameraButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  fitModelButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  wireframeButton.addEventListener("click", () => {
    currentWireframe = !currentWireframe;
    wireframeButton.setAttribute("aria-pressed", String(currentWireframe));
    if (currentMaterial) {
      currentMaterial.wireframe = currentWireframe;
      viewport?.requestRender();
    }
  });
  colorSelect.addEventListener("change", () => {
    currentColorHex = colorSelect.value;
    if (currentMaterial) {
      currentMaterial.color.set(currentColorHex);
      viewport?.requestRender();
    }
  });
  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  screenshotButton.addEventListener("click", () => {
    void exportScreenshot();
  });
  clearButton.addEventListener("click", clearFile);
  unitSelect.addEventListener("change", () => {
    currentUnit = unitSelect.value as STLDisplayUnit;
    if (lastBounds) renderDimensions(lastBounds);
  });

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
      showError({
        code: "UNSUPPORTED_BROWSER",
        message: `Your browser is missing a required feature: ${report.missingRequired.join(", ")}.`,
        recoverable: false,
      });
      if (report.recoveryMessages.length > 0) {
        errorGuidance.textContent = report.recoveryMessages.join(" ");
      }
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
