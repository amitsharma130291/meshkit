/**
 * Orchestration for /stl-to-obj/. Follows the same pattern as every other
 * converter's `_client.ts` (lazy Three.js viewport, camera fit with
 * OrbitControls damping cleared before repositioning, worker lifecycle) —
 * see docs/ARCHITECTURE.md for the reasoning behind each piece. The
 * differences here: the input is STL (parsed by the existing, unmodified
 * STL parser) and the output is OBJ text; the info panel shows this
 * converter's own metrics (source encoding, exact-duplicate references
 * removed, skipped-degenerate count) instead of any other converter's;
 * and, like OBJ→STL, there's no unit system to display or convert.
 *
 * Runs only when `document` exists — see the foundation-preview client
 * for why (Astro's static build imports client scripts into its server
 * module graph to resolve bundled asset URLs).
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { buildConvertedFilename } from "../../lib/files/download";
import { formatFileSize, formatMagnitude, formatTriangleCount } from "../../lib/stl/format";
import type { ConversionWarning, STLToOBJResult } from "../../lib/stl-to-obj/types";
import type { STLBounds } from "../../lib/stl/types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { initBatchEntitlementGate } from "../../lib/pro/batch-entitlement-gate";
import { createProductionEntitlementProvider } from "../../lib/pro/production-provider";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 100 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading file…",
  "detecting-stl-format": "Detecting format…",
  "parsing-stl": "Parsing STL…",
  "filtering-degenerate-facets": "Checking triangles…",
  "deduplicating-vertices": "Deduplicating vertices…",
  "writing-vertices": "Writing vertices…",
  "writing-normals": "Writing normals…",
  "writing-faces": "Writing faces…",
  "encoding-obj": "Encoding OBJ…",
  complete: "Finishing up…",
};

const ENCODING_LABELS: Record<string, string> = {
  binary: "Binary",
  ascii: "ASCII",
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
  const warningsBox = document.querySelector<HTMLElement>("[data-conversion-warnings]")!;
  const infoPanel = document.querySelector<HTMLElement>("[data-conversion-info]")!;
  const infoFilename = document.querySelector<HTMLElement>("[data-info-filename]")!;
  const infoFilesize = document.querySelector<HTMLElement>("[data-info-filesize]")!;
  const infoEncoding = document.querySelector<HTMLElement>("[data-info-encoding]")!;
  const infoInputTriangles = document.querySelector<HTMLElement>("[data-info-input-triangles]")!;
  const infoOutputFaces = document.querySelector<HTMLElement>("[data-info-output-faces]")!;
  const infoUniqueVertices = document.querySelector<HTMLElement>("[data-info-unique-vertices]")!;
  const infoDuplicatesRemoved = document.querySelector<HTMLElement>("[data-info-duplicates-removed]")!;
  const infoSkippedDegenerate = document.querySelector<HTMLElement>("[data-info-skipped-degenerate]")!;
  const infoOutputSize = document.querySelector<HTMLElement>("[data-info-output-size]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitModelButton = document.querySelector<HTMLButtonElement>('[data-action="fit-model"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const downloadButton = document.querySelector<HTMLButtonElement>('[data-action="download"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;

  const batchWorkspaceRoot = document.querySelector<HTMLElement>("[data-batch-workspace]");
  if (batchWorkspaceRoot) initBatchEntitlementGate(batchWorkspaceRoot, "convert-stl-to-obj", "batch-conversion", createProductionEntitlementProvider());

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastFileName = "";
  let lastRadius: number | null = null;
  let currentWireframe = false;
  let lastObjBuffer: ArrayBuffer | null = null;
  let lastDownloadFilename = "model.obj";

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let currentMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let currentGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let dampingActive = false;
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

  function disposeObjOutput(): void {
    lastObjBuffer = null;
    downloadButton.disabled = true;
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

    // See src/pages/stl-viewer/_client.ts for why residual OrbitControls
    // damping momentum must be cleared before a programmatic reposition.
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

  function buildMeshFromResult(result: STLToOBJResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();

    // Flat shading by default: an STL/OBJ pair never carries materials or
    // smoothing data, so the preview shouldn't imply either exists.
    const material = new THREE.MeshStandardMaterial({
      color: "#c7c2de",
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      flatShading: true,
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

  function renderWarnings(warnings: ConversionWarning[]): void {
    if (warnings.length === 0) {
      warningsBox.hidden = true;
      warningsBox.textContent = "";
      return;
    }
    warningsBox.hidden = false;
    warningsBox.textContent = "";
    const heading = document.createElement("p");
    heading.textContent = "A few things worth knowing about this conversion:";
    warningsBox.appendChild(heading);
    const list = document.createElement("ul");
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning.message;
      list.appendChild(item);
    }
    warningsBox.appendChild(list);
  }

  function renderInfo(result: STLToOBJResult): void {
    infoFilename.textContent = lastFileName;
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoEncoding.textContent = ENCODING_LABELS[result.inputEncoding] ?? result.inputEncoding;
    infoInputTriangles.textContent = formatTriangleCount(result.inputTriangleCount);
    infoOutputFaces.textContent = formatTriangleCount(result.outputFaceCount);
    infoUniqueVertices.textContent = formatTriangleCount(result.uniqueVertexCount);
    infoDuplicatesRemoved.textContent = formatTriangleCount(result.duplicateVertexReferencesRemoved);
    infoSkippedDegenerate.textContent = formatTriangleCount(result.skippedDegenerateTriangles);
    infoOutputSize.textContent = formatFileSize(result.outputByteLength);
    renderBounds(result.bounds);
    infoPanel.hidden = false;
  }

  function renderBounds(bounds: STLBounds): void {
    infoWidth.textContent = formatMagnitude(bounds.size[0]);
    infoHeight.textContent = formatMagnitude(bounds.size[1]);
    infoDepth.textContent = formatMagnitude(bounds.size[2]);
  }

  async function renderResult(result: STLToOBJResult): Promise<void> {
    try {
      await ensureViewer();
      buildMeshFromResult(result);

      lastObjBuffer = result.objBuffer;
      lastDownloadFilename = buildConvertedFilename(lastFileName, "stl", "obj");
      downloadButton.disabled = false;

      renderWarnings(result.warnings);
      renderInfo(result);

      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D preview couldn't start.", recoverable: false });
      setState("error");
    }
  }

  function createSTLToOBJWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/stl-to-obj.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createSTLToOBJWorker, {
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
        void renderResult(result as STLToOBJResult);
      },
      onError: (error) => {
        cancelButton.hidden = true;
        disposeObjOutput();
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

  function downloadObj(): void {
    if (!lastObjBuffer) return;
    try {
      const blob = new Blob([lastObjBuffer], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = lastDownloadFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      showError({ code: "UNKNOWN_ERROR", message: "Couldn't start the download. Try again.", recoverable: true });
    }
  }

  function resetResultsUI(): void {
    successConfirmation.hidden = true;
    infoPanel.hidden = true;
    warningsBox.hidden = true;
    warningsBox.textContent = "";
    disposeObjOutput();
  }

  function clearFile(): void {
    disposeSession();
    disposeCurrentModel();
    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    hideError();
    resetResultsUI();
    cancelButton.hidden = true;
    lastRadius = null;
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    resetResultsUI();

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
    lastFileName = file.name;
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
  downloadButton.addEventListener("click", downloadObj);
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
    disposeObjOutput();
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
