/**
 * Orchestration for /viewer/ — the universal 3D file viewer. Detects a
 * selected file's real format from content (`format-detection.ts`),
 * lazily loads the matching adapter (`adapter-registry.ts`), drives that
 * adapter's own worker through the same `WorkerClient` every dedicated
 * viewer page uses, and renders the result into the shared shell. This
 * file never parses geometry itself — every byte of format-specific
 * logic lives in `src/lib/viewer/adapters/*.ts`, which each wrap one
 * existing, unmodified worker.
 *
 * Resource ownership (see docs/ARCHITECTURE.md's own "Phase 4F —
 * resource ownership" section for the full table):
 *   - This file owns: the shared `ToolViewport`/`OrbitControls`/`THREE`
 *     instance (created once, reused across every format switch), the
 *     `WorkerClient` (recreated only when the detected format actually
 *     changes — reused across a same-format replacement), the
 *     `FileSession` (one per selected file), and the damping/resize/
 *     visibility event listeners.
 *   - Each adapter module owns: its own Three.js geometries, materials,
 *     textures and decoded `ImageBitmap`s, added to (and removed from)
 *     the one shared `scene` this file passes it — never touching the
 *     viewport/camera/renderer themselves.
 *   - `exportScreenshot()` owns its one object URL, created and revoked
 *     synchronously within the same function call — never left pending
 *     across a file replacement.
 *
 * A `generation` counter guards every async boundary (file read,
 * detection, adapter dynamic import, worker round-trip): a newer file
 * selection increments it, and any in-flight step whose captured
 * generation no longer matches silently abandons its result instead of
 * ever touching a UI that has already moved on to a different file —
 * this is what "cancel a request, then immediately discard whatever it
 * was about to say" means in practice, layered on top of
 * `WorkerClient`'s own stale-`requestId` protection (which alone
 * wouldn't cover the detection/adapter-load steps that happen before a
 * worker request even exists).
 *
 * Runs only when `document` exists — see the foundation-preview client
 * for why.
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { formatFileSize } from "../../lib/stl/format";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";
import { detectFormat, type DetectedFormat, type DetectionResult } from "../../lib/viewer/format-detection";
import { ADAPTER_LOADERS } from "../../lib/viewer/adapter-registry";
import { formatDetectedFormatLabel } from "../../lib/viewer/formatting";
import type { AdapterColorMode, AdapterContext, AdapterDisplayOptions, ViewerAdapter } from "../../lib/viewer/adapter-types";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_RENDERED_SEGMENT_ROWS = 150;

const STAGE_LABEL_FALLBACK = "Processing…";

function init(): void {
  const fileInput = document.querySelector<HTMLInputElement>("[data-file-input]")!;
  const filePickerWrap = document.querySelector<HTMLElement>("[data-local-file-picker]")!;
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
  const infoFilename = document.querySelector<HTMLElement>("[data-info-filename]")!;
  const infoFilesize = document.querySelector<HTMLElement>("[data-info-filesize]")!;
  const infoFormat = document.querySelector<HTMLElement>("[data-info-format]")!;
  const infoConfidence = document.querySelector<HTMLElement>("[data-info-confidence]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const infoFormatSpecific = document.querySelector<HTMLElement>("[data-info-format-specific]")!;
  const infoUnitNote = document.querySelector<HTMLElement>("[data-info-unit-note]")!;
  const infoExtensionMismatch = document.querySelector<HTMLElement>("[data-info-extension-mismatch]")!;
  const infoUnsupportedFeatures = document.querySelector<HTMLElement>("[data-info-unsupported-features]")!;
  const infoWarnings = document.querySelector<HTMLElement>("[data-info-warnings]")!;

  const sceneTree = document.querySelector<HTMLElement>("[data-scene-tree]")!;
  const sceneTreeNote = document.querySelector<HTMLElement>("[data-scene-tree-note]")!;
  const sceneTreeList = document.querySelector<HTMLElement>("[data-scene-tree-list]")!;
  const showAllButton = document.querySelector<HTMLButtonElement>('[data-action="show-all-segments"]')!;
  const hideAllButton = document.querySelector<HTMLButtonElement>('[data-action="hide-all-segments"]')!;

  const materialPanel = document.querySelector<HTMLElement>("[data-material-panel]")!;
  const materialList = document.querySelector<HTMLElement>("[data-material-list]")!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitVisibleButton = document.querySelector<HTMLButtonElement>('[data-action="fit-visible"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const wireframeField = document.querySelector<HTMLElement>('[data-control="wireframe"]')!;
  const colorModeField = document.querySelector<HTMLElement>('[data-control="color-mode"]')!;
  const colorModeSelect = document.querySelector<HTMLSelectElement>('[data-action="color-mode"]')!;
  const shadingField = document.querySelector<HTMLElement>('[data-control="shading"]')!;
  const shadingSelect = document.querySelector<HTMLSelectElement>('[data-action="shading-mode"]')!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  // --- Universal orchestration state (owned by this file) ---
  let generation = 0;
  // The generation the currently in-flight (or most recently sent) worker
  // request belongs to. The WorkerClient instance is reused across file
  // selections whenever the detected format doesn't change (see
  // `ensureWorkerForFormat`), so its event callbacks are only ever bound
  // once per worker creation — they must read this live value rather than
  // close over a single call's `myGeneration`, or every response after the
  // first same-format load would be compared against a stale snapshot and
  // silently dropped forever.
  let requestGeneration = 0;
  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let workerFormat: DetectedFormat | null = null;
  let currentAdapter: ViewerAdapter | null = null;
  let lastResult: unknown = null;
  let lastFileSize = 0;
  let lastFullRadius: number | null = null;

  let hiddenSegmentKeys = new Set<string>();
  let colorMode: AdapterColorMode = "original";
  let shadingMode: "source" | "flat" = "source";
  let wireframe = false;
  let modelColorHex = colorSelect.value || "#c7c2de";
  let gridVisible = false;
  let axesVisible = false;

  // --- Shared viewport (owned by this file, reused across every format) ---
  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let currentGridHelper: InstanceType<ThreeModule["GridHelper"]> | null = null;
  let currentAxesHelper: InstanceType<ThreeModule["AxesHelper"]> | null = null;
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

  function currentOptions(): AdapterDisplayOptions {
    return { wireframe, shadingMode, colorMode, modelColorHex, hiddenSegmentKeys };
  }

  function adapterContext(): AdapterContext {
    return {
      THREE: THREE!,
      scene: viewport!.scene,
      requestRender: () => viewport?.requestRender(),
      onContextLost: (error) => {
        showError(error);
        setState("error");
      },
    };
  }

  function disposeSession(): void {
    currentSession?.dispose();
    currentSession = null;
  }

  function disposeCurrentScene(): void {
    if (currentAdapter && viewport && THREE) currentAdapter.disposeScene(adapterContext());
    if (currentGridHelper && viewport) {
      viewport.scene.remove(currentGridHelper);
      disposeObject3D(currentGridHelper);
      currentGridHelper = null;
    }
    if (currentAxesHelper && viewport) {
      viewport.scene.remove(currentAxesHelper);
      disposeObject3D(currentAxesHelper);
      currentAxesHelper = null;
    }
    lastResult = null;
    lastFullRadius = null;
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
    disposeCurrentScene();
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

  function fitCameraAndControls(radius: number, target: [number, number, number] = [0, 0, 0]): void {
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
    const targetOffset = Math.max(Math.abs(target[0]), Math.abs(target[1]), Math.abs(target[2]));

    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    const targetVector = new THREE.Vector3(target[0], target[1], target[2]);
    camera.position.copy(direction.multiplyScalar(distance).add(targetVector));
    camera.near = Math.max(distance / 1000, 0.001);
    camera.far = distance * 100 + targetOffset * 2;
    camera.updateProjectionMatrix();

    orbitControls.target.copy(targetVector);
    orbitControls.minDistance = safeRadius * 0.4;
    orbitControls.maxDistance = safeRadius * 12 + targetOffset * 2;
    orbitControls.update();
    viewport.requestRender();
  }

  function fitVisible(): void {
    if (!currentAdapter || lastResult === null) return;
    const target = currentAdapter.fitVisibleTarget(lastResult, hiddenSegmentKeys);
    if (target) fitCameraAndControls(target.radius, target.center);
    else if (lastFullRadius !== null) fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  }

  // --- Generic info / scene tree / materials rendering (adapter-driven) ---

  function renderWarnings(warnings: { message: string }[]): void {
    if (warnings.length === 0) {
      infoWarnings.hidden = true;
      infoWarnings.textContent = "";
      return;
    }
    infoWarnings.hidden = false;
    infoWarnings.textContent = "";
    const heading = document.createElement("p");
    heading.textContent = `Things to know about this file (${warnings.length}):`;
    infoWarnings.appendChild(heading);
    const list = document.createElement("ul");
    for (const w of warnings) {
      const item = document.createElement("li");
      item.textContent = w.message;
      list.appendChild(item);
    }
    infoWarnings.appendChild(list);
  }

  function renderInfo(adapter: ViewerAdapter, result: unknown, detection: DetectionResult, fileName: string): void {
    infoFilename.textContent = fileName;
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoFormat.textContent = detection.format ? formatDetectedFormatLabel(detection.format) : "Unknown";
    infoConfidence.textContent = detection.confidence;

    const dims = adapter.dimensions(result);
    infoWidth.textContent = dims.width;
    infoHeight.textContent = dims.height;
    infoDepth.textContent = dims.depth;

    infoFormatSpecific.textContent = "";
    for (const field of adapter.info(result)) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = field.label;
      const dd = document.createElement("dd");
      dd.textContent = field.value;
      row.append(dt, dd);
      infoFormatSpecific.appendChild(row);
    }

    const caps = adapter.capabilities(result);
    infoUnitNote.textContent = `Unit: ${caps.unitNote}.`;

    if (detection.extensionMatches === false && detection.format) {
      infoExtensionMismatch.hidden = false;
      infoExtensionMismatch.textContent = `This file's extension doesn't match its detected content (${formatDetectedFormatLabel(detection.format)}). It was opened according to its actual content.`;
    } else {
      infoExtensionMismatch.hidden = true;
    }

    const unsupportedNote = adapter.unsupportedFeaturesNote(result);
    if (unsupportedNote) {
      infoUnsupportedFeatures.hidden = false;
      infoUnsupportedFeatures.textContent = unsupportedNote;
    } else {
      infoUnsupportedFeatures.hidden = true;
    }

    renderWarnings(adapter.warnings(result));
    modelInfo.hidden = false;
  }

  function renderMaterials(adapter: ViewerAdapter, result: unknown): void {
    const materials = adapter.materials(result);
    if (!materials || materials.length === 0) {
      materialPanel.hidden = true;
      materialList.textContent = "";
      return;
    }
    materialPanel.hidden = false;
    materialList.textContent = "";
    for (const mat of materials) {
      const card = document.createElement("div");
      card.className = "glb-material-card";
      const swatch = document.createElement("span");
      swatch.className = "glb-material-swatch";
      swatch.style.background = mat.colorHex;
      const details = document.createElement("div");
      details.className = "glb-material-details";
      const name = document.createElement("p");
      name.className = "glb-material-name";
      name.textContent = mat.name;
      const meta = document.createElement("p");
      meta.className = "glb-material-meta";
      meta.textContent = mat.meta;
      details.append(name, meta);
      card.append(swatch, details);
      materialList.appendChild(card);
    }
  }

  function renderSceneTree(adapter: ViewerAdapter, result: unknown): void {
    const rows = adapter.segments(result);
    if (!rows || rows.length === 0) {
      sceneTree.hidden = true;
      sceneTreeList.textContent = "";
      return;
    }
    sceneTree.hidden = false;
    sceneTreeList.textContent = "";

    const rendered = rows.slice(0, MAX_RENDERED_SEGMENT_ROWS);
    const overflow = rows.length - rendered.length;
    sceneTreeNote.textContent = overflow > 0 ? `Showing ${rendered.length} of ${rows.length} parts individually.` : `${rows.length} rendered ${rows.length === 1 ? "part" : "parts"}.`;

    const groupOrder: string[] = [];
    const byGroup = new Map<string, typeof rendered>();
    for (const row of rendered) {
      if (!byGroup.has(row.groupLabel)) {
        byGroup.set(row.groupLabel, []);
        groupOrder.push(row.groupLabel);
      }
      byGroup.get(row.groupLabel)!.push(row);
    }

    for (const groupLabel of groupOrder) {
      const wrap = document.createElement("div");
      wrap.className = "scene-tree-object-group";
      const heading = document.createElement("p");
      heading.className = "scene-tree-object-name";
      heading.textContent = groupLabel;
      wrap.appendChild(heading);

      for (const row of byGroup.get(groupLabel)!) {
        const rowEl = document.createElement("div");
        rowEl.className = "scene-tree-row";
        const checkboxId = `universal-viewer-seg-${row.key}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = checkboxId;
        checkbox.checked = !hiddenSegmentKeys.has(row.key);
        checkbox.setAttribute("aria-label", `Show ${row.rowLabel}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenSegmentKeys.delete(row.key);
          else hiddenSegmentKeys.add(row.key);
          applyDisplayOptions();
        });
        const label = document.createElement("label");
        label.className = "scene-tree-row-label";
        label.setAttribute("for", checkboxId);
        label.textContent = row.rowLabel;
        const count = document.createElement("span");
        count.className = "scene-tree-row-count";
        count.textContent = row.countLabel;
        rowEl.append(checkbox, label, count);
        wrap.appendChild(rowEl);
      }
      sceneTreeList.appendChild(wrap);
    }
  }

  function setupDisplayControls(adapter: ViewerAdapter, result: unknown): void {
    const caps = adapter.capabilities(result);

    wireframeField.hidden = !caps.wireframe;
    wireframe = false;
    wireframeButton.setAttribute("aria-pressed", "false");

    shadingField.hidden = !caps.shading;
    shadingMode = "source";
    shadingSelect.value = "source";

    colorModeField.hidden = caps.colorModes.length === 0;
    colorMode = caps.colorModes[0] ?? "original";
    colorModeSelect.value = colorMode;
    for (const option of Array.from(colorModeSelect.options)) {
      option.hidden = !caps.colorModes.includes(option.value as AdapterColorMode);
    }

    hiddenSegmentKeys = new Set();
  }

  function applyDisplayOptions(): void {
    if (!currentAdapter || !viewport || !THREE) return;
    currentAdapter.applyDisplayOptions(adapterContext(), currentOptions());
  }

  async function buildScene(adapter: ViewerAdapter, result: unknown): Promise<void> {
    await ensureViewer();
    if (!viewport || !THREE) return;
    disposeCurrentScene();
    await adapter.buildScene(adapterContext(), result, currentOptions());

    const target = adapter.fitAllTarget(result);
    lastFullRadius = target.radius;
    const helperSize = Math.max(lastFullRadius * 4, 2);
    const grid = new THREE.GridHelper(helperSize, 20, 0x6d42f5, 0xd8d3f0);
    grid.visible = gridVisible;
    viewport.scene.add(grid);
    currentGridHelper = grid;
    const axes = new THREE.AxesHelper(helperSize / 2);
    axes.visible = axesVisible;
    viewport.scene.add(axes);
    currentAxesHelper = axes;

    fitCameraAndControls(lastFullRadius, target.center);
  }

  // --- Worker lifecycle (one WorkerClient, recreated only when the detected format changes) ---

  async function ensureWorkerForFormat(adapter: ViewerAdapter, myGeneration: number): Promise<boolean> {
    if (workerClient && workerFormat === adapter.format) return true;

    workerClient?.dispose();
    workerClient = null;
    workerReady = false;
    workerFormat = adapter.format;

    return new Promise<boolean>((resolve) => {
      workerClient = new WorkerClient(() => adapter.createWorker(), {
        onReady: () => {
          if (myGeneration !== generation) return;
          workerReady = true;
          resolve(true);
        },
        onProgress: (stage) => {
          if (requestGeneration !== generation) return;
          setState("processing");
          statusLabel.textContent = stage === "complete" ? TOOL_STATE_LABELS.processing : STAGE_LABEL_FALLBACK;
          cancelButton.hidden = false;
        },
        onResult: (result) => {
          if (requestGeneration !== generation) return;
          cancelButton.hidden = true;
          void handleWorkerResult(adapter, result);
        },
        onError: (error) => {
          if (requestGeneration !== generation) return;
          cancelButton.hidden = true;
          showError(error);
          setState("error");
        },
        onCancelled: () => {
          if (requestGeneration !== generation) return;
          cancelButton.hidden = true;
          setState("cancelled");
        },
      });
      try {
        workerClient.initialize();
      } catch {
        resolve(false);
      }
    });
  }

  async function handleWorkerResult(adapter: ViewerAdapter, result: unknown): Promise<void> {
    try {
      lastResult = result;
      setupDisplayControls(adapter, result);
      await buildScene(adapter, result);
      renderInfo(adapter, result, pendingDetection!, currentSession!.file.name);
      renderMaterials(adapter, result);
      renderSceneTree(adapter, result);
      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false });
      setState("error");
    }
  }

  let pendingDetection: DetectionResult | null = null;

  async function processSelectedFile(file: File): Promise<void> {
    const myGeneration = ++generation;

    hideError();
    resetResultsUI();
    disposeCurrentScene();
    workerClient?.cancel();

    // Deliberately not `validateSelectedFile()` — every dedicated viewer
    // page uses it to reject a file whose extension isn't in that page's
    // own single-format allow-list, which is exactly the extension-gates-
    // content behavior this page must never have. Only a size ceiling is
    // checked before detection; the detected content, never the
    // extension, decides what happens next.
    if (file.size > MAX_SIZE_BYTES) {
      fileMessage.textContent = "That file is larger than this tool currently supports.";
      fileMessage.dataset.state = "error";
      setState("idle");
      return;
    }

    disposeSession();
    currentSession = new FileSession(file, "");
    currentSession.registerCleanup(() => workerClient?.cancel());
    lastFileSize = file.size;
    fileMessage.textContent = `${file.name} selected (${formatFileSize(file.size)}).`;
    fileMessage.dataset.state = "success";
    setState("initializing");
    statusLabel.textContent = "Detecting format…";

    let buffer: ArrayBuffer;
    try {
      buffer = await currentSession.readArrayBuffer();
    } catch (error) {
      if (myGeneration !== generation) return;
      if (isSafeError(error)) showError(error);
      setState("error");
      return;
    }
    if (myGeneration !== generation) return;

    const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : null;
    const detection = detectFormat(buffer, extension);

    if (!detection.format) {
      showError({ code: "VIEWER_FORMAT_UNKNOWN", message: "MeshWrench couldn't confidently identify this file's 3D format. Supported formats: STL, OBJ, 3MF, GLB, PLY, and binary FBX.", recoverable: true });
      setState("error");
      return;
    }

    pendingDetection = detection;
    setState("initializing");
    statusLabel.textContent = `Loading ${formatDetectedFormatLabel(detection.format)} viewer…`;

    let adapterModule;
    try {
      adapterModule = await ADAPTER_LOADERS[detection.format]();
    } catch {
      if (myGeneration !== generation) return;
      showError({ code: "VIEWER_ADAPTER_LOAD_FAILED", message: "The local viewer engine for this format couldn't be loaded.", recoverable: true });
      setState("error");
      return;
    }
    if (myGeneration !== generation) return;

    const adapter = adapterModule.default;
    currentAdapter = adapter;
    workerClient?.cancel();

    setState("processing");
    const ready = await ensureWorkerForFormat(adapter, myGeneration);
    if (myGeneration !== generation) return;
    if (!ready) {
      showError({ code: "WORKER_INIT_FAILED", message: "The local processing engine couldn't start.", recoverable: false });
      setState("error");
      return;
    }

    if (!workerClient || !workerReady) return;
    requestGeneration = myGeneration;
    workerClient.process(file.name, detection.format, buffer, {});
  }

  function resetResultsUI(): void {
    successConfirmation.hidden = true;
    modelInfo.hidden = true;
    infoFormatSpecific.textContent = "";
    sceneTree.hidden = true;
    sceneTreeList.textContent = "";
    materialPanel.hidden = true;
    materialList.textContent = "";
    infoWarnings.hidden = true;
    infoWarnings.textContent = "";
  }

  function clearFile(): void {
    generation++;
    workerClient?.cancel();
    disposeSession();
    disposeCurrentScene();
    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    hideError();
    resetResultsUI();
    cancelButton.hidden = true;
    currentAdapter = null;
    hiddenSegmentKeys = new Set();
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void processSelectedFile(file);
  });

  // Additive drag-and-drop on the existing file-picker wrapper — never changes LocalFilePicker.astro itself, matching that component's own "a future page can listen on data-local-file-picker without changing this markup" design intent.
  filePickerWrap.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  filePickerWrap.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    void processSelectedFile(file);
  });

  cancelButton.addEventListener("click", () => {
    workerClient?.cancel();
  });

  resetCameraButton.addEventListener("click", () => {
    if (lastFullRadius !== null) fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  });
  fitAllButton.addEventListener("click", () => {
    if (lastFullRadius !== null) fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  });
  fitVisibleButton.addEventListener("click", fitVisible);

  wireframeButton.addEventListener("click", () => {
    wireframe = !wireframe;
    wireframeButton.setAttribute("aria-pressed", String(wireframe));
    applyDisplayOptions();
  });
  colorModeSelect.addEventListener("change", () => {
    colorMode = colorModeSelect.value as AdapterColorMode;
    applyDisplayOptions();
  });
  shadingSelect.addEventListener("change", () => {
    shadingMode = shadingSelect.value === "flat" ? "flat" : "source";
    applyDisplayOptions();
  });
  colorSelect.addEventListener("change", () => {
    modelColorHex = colorSelect.value;
    applyDisplayOptions();
  });
  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  gridButton.addEventListener("click", () => {
    gridVisible = !gridVisible;
    gridButton.setAttribute("aria-pressed", String(gridVisible));
    gridButton.textContent = gridVisible ? "Hide grid" : "Show grid";
    if (currentGridHelper) {
      currentGridHelper.visible = gridVisible;
      viewport?.requestRender();
    }
  });
  axesButton.addEventListener("click", () => {
    axesVisible = !axesVisible;
    axesButton.setAttribute("aria-pressed", String(axesVisible));
    axesButton.textContent = axesVisible ? "Hide axes" : "Show axes";
    if (currentAxesHelper) {
      currentAxesHelper.visible = axesVisible;
      viewport?.requestRender();
    }
  });

  showAllButton.addEventListener("click", () => {
    hiddenSegmentKeys.clear();
    applyDisplayOptions();
    if (currentAdapter && lastResult !== null) renderSceneTree(currentAdapter, lastResult);
  });
  hideAllButton.addEventListener("click", () => {
    if (!currentAdapter || lastResult === null) return;
    const rows = currentAdapter.segments(lastResult);
    if (!rows) return;
    hiddenSegmentKeys = new Set(rows.map((r) => r.key));
    applyDisplayOptions();
    renderSceneTree(currentAdapter, lastResult);
  });

  screenshotButton.addEventListener("click", () => {
    void exportScreenshot();
  });
  async function exportScreenshot(): Promise<void> {
    if (!viewport || !currentSession) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => viewport!.canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("empty blob");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const base = currentSession.file.name.replace(/\.[^.]+$/, "");
      link.download = `${base || "model"}-screenshot.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      showError({ code: "UNKNOWN_ERROR", message: "Couldn't generate a screenshot. Try again.", recoverable: true });
    }
  }

  document.querySelectorAll<HTMLButtonElement>('[data-action="clear-file"]').forEach((button) => {
    button.addEventListener("click", clearFile);
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
      showError({ code: "UNSUPPORTED_BROWSER", message: `Your browser is missing a required feature: ${report.missingRequired.join(", ")}.`, recoverable: false });
      if (report.recoveryMessages.length > 0) errorGuidance.textContent = report.recoveryMessages.join(" ");
      return;
    }
    setState("idle");
  }

  void boot();
}

if (typeof document !== "undefined") {
  init();
}
