/**
 * Orchestration for STL Diagnostics — the SHARED implementation behind
 * both `/stl-checker/` (primary) and `/stl-validator/` (secondary SEO
 * route). `/stl-validator/`'s own `<script>` tag imports this exact
 * module (`import "../stl-checker/_client";`) rather than duplicating
 * any of it — one analysis implementation, two SEO-differentiated pages
 * around it, per this phase's own explicit requirement.
 *
 * Worker lifecycle deliberately follows `stl-viewer/_client.ts`'s
 * single-persistent-worker pattern (one `WorkerClient`, created once at
 * boot, its event callbacks bound exactly once) rather than the Universal
 * Viewer's per-format worker-reuse pattern — this page only ever handles
 * one format, so the async boundary that caused the Universal Viewer's
 * own stale-`generation`-closure bug (reusing a worker's callbacks across
 * a changing concern) never arises here structurally. Repeated STL
 * selections are still verified end-to-end in browser testing, the same
 * way that fix was verified, specifically to confirm this pattern really
 * is immune rather than just assumed to be.
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { sanitizeDownloadBasename, buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize, formatMagnitude, formatTriangleCount } from "../../lib/stl/format";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS, type STLDiagnosticsWorkerResult, type STLDiagnosticsReport } from "../../lib/stl-diagnostics/types";
import { buildDownloadableReport } from "../../lib/stl-diagnostics/report";
import {
  formatDurationMs,
  formatReasonCode,
  formatShellOrientation,
  formatVerdict,
} from "../../lib/stl-diagnostics/formatting";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 150 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading STL…",
  "building-topology": "Building topology…",
  "checking-triangles": "Checking triangles…",
  "classifying-edges": "Classifying edges…",
  "finding-boundary-components": "Finding boundary components…",
  "resolving-shells": "Resolving shells…",
  "checking-orientation": "Checking orientation…",
  "building-spatial-index": "Building spatial index…",
  "checking-intersections": "Checking intersections…",
  "preparing-report": "Preparing report…",
  complete: "Finishing up…",
};

type CheckKey = "degenerate-triangles" | "duplicate-faces" | "boundary-edges" | "non-manifold-edges" | "winding-conflicts" | "inward-shells" | "disconnected-shells" | "self-intersections";
type CheckStatus = "passed" | "warning" | "failed" | "not-checked";

const SHELL_PALETTE = ["#6d42f5", "#24b8d8", "#ed4b93", "#f5a623", "#2ecc71", "#e0303f", "#8e44ad", "#16a085"];

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

  const summaryPanel = document.querySelector<HTMLElement>("[data-diagnostics-summary]")!;
  const verdictBadge = document.querySelector<HTMLElement>("[data-verdict-badge]")!;
  const verdictLabel = document.querySelector<HTMLElement>("[data-verdict-label]")!;
  const verdictDetail = document.querySelector<HTMLElement>("[data-verdict-detail]")!;
  const slicerRiskList = document.querySelector<HTMLElement>("[data-slicer-risk-list]")!;
  const slicerDisclaimers = document.querySelector<HTMLElement>("[data-slicer-disclaimers]")!;

  const checksPanel = document.querySelector<HTMLElement>("[data-diagnostics-checks]")!;
  const checkRows = new Map<CheckKey, HTMLElement>();
  checksPanel.querySelectorAll<HTMLElement>("[data-check]").forEach((row) => checkRows.set(row.dataset.check as CheckKey, row));

  const detailsPanel = document.querySelector<HTMLElement>("[data-diagnostics-details]")!;
  const shellList = document.querySelector<HTMLElement>("[data-shell-list]")!;
  const stageTimingList = document.querySelector<HTMLElement>("[data-stage-timing-list]")!;
  const warningsBox = document.querySelector<HTMLElement>("[data-diagnostics-warnings]")!;
  const downloadReportButton = document.querySelector<HTMLButtonElement>('[data-action="download-report"]')!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitSelectedButton = document.querySelector<HTMLButtonElement>('[data-action="fit-selected-issue"]')!;
  const overlayToggleButtons = document.querySelectorAll<HTMLButtonElement>('[data-action="toggle-overlay"]');
  const showAllButton = document.querySelector<HTMLButtonElement>('[data-action="show-all-overlays"]')!;
  const hideAllButton = document.querySelector<HTMLButtonElement>('[data-action="hide-all-overlays"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;
  const highlightButtons = document.querySelectorAll<HTMLButtonElement>('[data-action="highlight-check"]');

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastRadius: number | null = null;
  let lastResult: STLDiagnosticsWorkerResult | null = null;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let dampingActive = false;
  let dampingStopTimer: number | null = null;

  let baseMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let baseGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let baseMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;

  const overlayObjects = new Map<string, InstanceType<ThreeModule["Object3D"]>>();
  const overlayGeometries: InstanceType<ThreeModule["BufferGeometry"]>[] = [];
  const overlayMaterials: (InstanceType<ThreeModule["Material"]>)[] = [];
  const shellObjects = new Map<number, InstanceType<ThreeModule["Object3D"]>>();

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

  function disposeOverlays(): void {
    if (viewport) {
      for (const obj of overlayObjects.values()) viewport.scene.remove(obj);
      for (const obj of shellObjects.values()) viewport.scene.remove(obj);
    }
    for (const g of overlayGeometries) g.dispose();
    for (const m of overlayMaterials) m.dispose();
    overlayObjects.clear();
    shellObjects.clear();
    overlayGeometries.length = 0;
    overlayMaterials.length = 0;
  }

  function disposeCurrentModel(): void {
    if (baseMesh && viewport) viewport.scene.remove(baseMesh);
    baseGeometry?.dispose();
    baseMaterial?.dispose();
    baseMesh = null;
    baseGeometry = null;
    baseMaterial = null;
    disposeOverlays();
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

  function fitCameraAndControls(radius: number, center: [number, number, number] = [0, 0, 0]): void {
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

    const direction = new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(distance);
    camera.position.set(center[0] + direction.x, center[1] + direction.y, center[2] + direction.z);
    camera.near = Math.max(distance / 1000, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    orbitControls.target.set(center[0], center[1], center[2]);
    orbitControls.minDistance = safeRadius * 0.4;
    orbitControls.maxDistance = safeRadius * 12;
    orbitControls.update();
    viewport.requestRender();
  }

  // --- Model + overlay construction ---------------------------------

  let modelOffset: [number, number, number] = [0, 0, 0];

  function buildBaseMesh(result: STLDiagnosticsWorkerResult): void {
    if (!viewport || !THREE) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.stl.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.stl.normals, 3));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();

    const material = new THREE.MeshStandardMaterial({ color: "#c7c2de", metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    modelOffset = [-sphere.center.x, -sphere.center.y, -sphere.center.z];
    mesh.position.set(...modelOffset);
    viewport.scene.add(mesh);

    baseMesh = mesh;
    baseGeometry = geometry;
    baseMaterial = material;
    lastRadius = Math.max(sphere.radius, 1e-6);
  }

  function makeLineOverlay(positions: Float32Array, color: string): InstanceType<ThreeModule["LineSegments"]> | null {
    if (!THREE || positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    overlayGeometries.push(geometry);
    overlayMaterials.push(material);
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 10;
    lines.position.set(...modelOffset);
    return lines;
  }

  function makeTriangleOverlay(positions: Float32Array, color: string): InstanceType<ThreeModule["Mesh"]> | null {
    if (!THREE || positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 });
    overlayGeometries.push(geometry);
    overlayMaterials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 11;
    mesh.position.set(...modelOffset);
    return mesh;
  }

  function buildOverlays(report: STLDiagnosticsReport): void {
    if (!viewport) return;
    const o = report.overlays;
    const entries: [string, InstanceType<ThreeModule["Object3D"]> | null][] = [
      ["boundary-edges", makeLineOverlay(o.boundaryEdgeLines, "#ff8a3d")],
      ["non-manifold-edges", makeLineOverlay(o.nonManifoldEdgeLines, "#e0303f")],
      ["winding-conflicts", makeLineOverlay(o.windingConflictEdgeLines, "#c837d6")],
      ["degenerate-triangles", makeTriangleOverlay(o.degenerateTrianglePositions, "#e8c400")],
      ["duplicate-faces", makeTriangleOverlay(o.duplicateFacePositions, "#22c3c3")],
      ["self-intersections", makeTriangleOverlay(o.selfIntersectingTrianglePositions, "#ff1f4b")],
    ];
    for (const [key, obj] of entries) {
      if (!obj) continue;
      obj.visible = true;
      viewport.scene.add(obj);
      overlayObjects.set(key, obj);
    }

    let shellIndex = 0;
    for (const [idStr, positions] of Object.entries(o.shellPositionsById)) {
      const id = Number(idStr);
      const color = SHELL_PALETTE[shellIndex % SHELL_PALETTE.length];
      shellIndex++;
      const mesh = makeTriangleOverlay(positions, color);
      if (!mesh) continue;
      mesh.visible = false; // shell highlighting is opt-in via the shell list, not shown by default
      viewport.scene.add(mesh);
      shellObjects.set(id, mesh);
    }
  }

  // --- Result rendering ------------------------------------------------

  function renderVerdict(report: STLDiagnosticsReport): void {
    verdictBadge.dataset.verdict = report.verdict;
    verdictLabel.textContent = formatVerdict(report.verdict);
    verdictDetail.textContent = report.reasonCodes.map(formatReasonCode).join(" ");

    slicerRiskList.textContent = "";
    for (const flag of report.slicerRisk) {
      const li = document.createElement("li");
      li.className = `slicer-risk-item risk-${flag.severity}`;
      li.textContent = flag.message;
      slicerRiskList.appendChild(li);
    }

    slicerDisclaimers.textContent = "";
    const disclaimers = [
      "Passing these checks does not guarantee a model will print successfully.",
      "Failing one or more of these checks does not mean a model cannot be sliced — many slicers auto-repair minor issues.",
      "Wall thickness, physical scale, your printer's own limits, support requirements and manufacturing tolerances are outside what this checker evaluates.",
    ];
    for (const text of disclaimers) {
      const p = document.createElement("p");
      p.textContent = text;
      slicerDisclaimers.appendChild(p);
    }

    summaryPanel.hidden = false;
  }

  function checkRowFor(report: STLDiagnosticsReport, key: CheckKey): { status: CheckStatus; count: number } {
    switch (key) {
      case "degenerate-triangles":
        return { status: report.degenerateTriangleCount > 0 ? "warning" : "passed", count: report.degenerateTriangleCount };
      case "duplicate-faces": {
        const count = report.sameWindingDuplicateFaceCount + report.reverseWindingDuplicateFaceCount;
        return { status: count > 0 ? "failed" : "passed", count };
      }
      case "boundary-edges":
        return { status: report.boundaryEdgeCount > 0 ? "failed" : "passed", count: report.boundaryEdgeCount };
      case "non-manifold-edges":
        return { status: report.nonManifoldEdgeCount > 0 ? "failed" : "passed", count: report.nonManifoldEdgeCount };
      case "winding-conflicts":
        return { status: report.windingConflictEdgeCount > 0 ? "failed" : "passed", count: report.windingConflictEdgeCount };
      case "inward-shells":
        return { status: report.inwardShellCount > 0 ? "warning" : "passed", count: report.inwardShellCount };
      case "disconnected-shells":
        return { status: report.shellCount > 1 ? "warning" : "passed", count: report.shellCount };
      case "self-intersections":
        if (report.selfIntersections.status === "not-checked") return { status: "not-checked", count: 0 };
        return { status: report.selfIntersections.intersectingPairCount > 0 ? "failed" : "passed", count: report.selfIntersections.intersectingPairCount };
    }
  }

  function renderChecks(report: STLDiagnosticsReport): void {
    for (const [key, row] of checkRows) {
      const { status, count } = checkRowFor(report, key);
      const badge = row.querySelector<HTMLElement>("[data-check-status]")!;
      badge.dataset.checkStatus = status;
      badge.textContent = status === "not-checked" ? "Not checked" : status === "passed" ? "Passed" : status === "warning" ? "Warning" : "Failed";
      row.querySelector<HTMLElement>("[data-check-count]")!.textContent = status === "not-checked" ? "" : formatTriangleCount(count);
      const highlightButton = row.querySelector<HTMLButtonElement>('[data-action="highlight-check"]')!;
      highlightButton.disabled = status === "not-checked" || count === 0;
    }
    checksPanel.hidden = false;
  }

  function renderDetails(report: STLDiagnosticsReport): void {
    const set = (selector: string, text: string) => {
      const el = detailsPanel.querySelector<HTMLElement>(selector);
      if (el) el.textContent = text;
    };
    set("[data-detail-file-size]", formatFileSize(lastFileSize));
    set("[data-detail-triangle-count]", formatTriangleCount(report.triangleCount));
    set("[data-detail-valid-triangle-count]", formatTriangleCount(report.validTriangleCount));
    set("[data-detail-degenerate-count]", formatTriangleCount(report.degenerateTriangleCount));
    set("[data-detail-source-vertex-count]", formatTriangleCount(report.sourceVertexSlotCount));
    set("[data-detail-unique-vertex-count]", formatTriangleCount(report.uniqueVertexPositionCount));
    set("[data-detail-duplicate-coordinate-count]", formatTriangleCount(report.duplicateCoordinateReferenceCount));
    set("[data-detail-surface-area]", `${formatMagnitude(report.surfaceArea)} sq. model units`);
    set("[data-detail-enclosed-volume]", report.totalEnclosedVolume === null ? "— (no fully closed, consistently-oriented shell)" : `${formatMagnitude(report.totalEnclosedVolume)} cu. model units`);
    set("[data-detail-boundary-edge-count]", formatTriangleCount(report.boundaryEdgeCount));
    set("[data-detail-closed-loop-count]", formatTriangleCount(report.closedLoopBoundaryCount));
    set("[data-detail-open-chain-count]", formatTriangleCount(report.openChainBoundaryCount));
    set("[data-detail-branched-count]", formatTriangleCount(report.branchedBoundaryCount));
    set("[data-detail-non-simple-count]", formatTriangleCount(report.nonSimpleBoundaryCount));

    shellList.textContent = "";
    report.shells.forEach((shell, i) => {
      const li = document.createElement("li");
      li.className = "shell-row";
      const color = SHELL_PALETTE[i % SHELL_PALETTE.length];
      li.innerHTML = `<span class="overlay-swatch" style="background:${color}" aria-hidden="true"></span> Shell ${shell.id}: ${formatTriangleCount(shell.triangleCount)} triangles, ${shell.closed ? "closed" : "open"}, ${formatShellOrientation(shell.orientation)}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "control-button small";
      button.textContent = "Highlight";
      button.addEventListener("click", () => highlightShell(shell.id));
      li.appendChild(button);
      shellList.appendChild(li);
    });
    if (report.shellsTruncated) {
      const note = document.createElement("li");
      note.textContent = `Only the first ${report.shells.length} of ${report.shellCount} shells are listed in detail.`;
      shellList.appendChild(note);
    }

    stageTimingList.textContent = "";
    for (const stage of report.stageTimings) {
      const dt = document.createElement("div");
      dt.innerHTML = `<dt>${STAGE_LABELS[stage.stage] ?? stage.stage}</dt><dd>${formatDurationMs(stage.durationMs)}</dd>`;
      stageTimingList.appendChild(dt);
    }

    warningsBox.textContent = "";
    if (report.warnings.length > 0) {
      const ul = document.createElement("ul");
      for (const w of report.warnings) {
        const li = document.createElement("li");
        li.textContent = w.message;
        ul.appendChild(li);
      }
      warningsBox.appendChild(ul);
      warningsBox.hidden = false;
    } else {
      warningsBox.hidden = true;
    }

    detailsPanel.hidden = false;
  }

  function highlightShell(id: number): void {
    if (!viewport || !THREE) return;
    for (const obj of shellObjects.values()) obj.visible = false;
    const target = shellObjects.get(id);
    if (target) {
      target.visible = true;
      const geom = (target as InstanceType<ThreeModule["Mesh"]>).geometry;
      geom.computeBoundingSphere();
      const sphere = geom.boundingSphere;
      if (sphere) fitCameraAndControls(Math.max(sphere.radius, 1e-6), [sphere.center.x + modelOffset[0], sphere.center.y + modelOffset[1], sphere.center.z + modelOffset[2]]);
    }
    fitSelectedButton.disabled = !target;
    viewport.requestRender();
  }

  function highlightOverlay(key: string): void {
    if (!viewport || !THREE) return;
    const obj = overlayObjects.get(key);
    if (!obj) return;
    obj.visible = true;
    setOverlayButtonPressed(key, true);
    const geom = (obj as InstanceType<ThreeModule["Mesh"]> | InstanceType<ThreeModule["LineSegments"]>).geometry;
    geom.computeBoundingSphere();
    const sphere = geom.boundingSphere;
    if (sphere && sphere.radius > 0) {
      fitCameraAndControls(sphere.radius, [sphere.center.x + modelOffset[0], sphere.center.y + modelOffset[1], sphere.center.z + modelOffset[2]]);
    }
    fitSelectedButton.disabled = false;
    fitSelectedButton.dataset.lastOverlay = key;
    viewport.requestRender();
  }

  function setOverlayButtonPressed(overlayKey: string, pressed: boolean): void {
    overlayToggleButtons.forEach((btn) => {
      if (btn.dataset.overlay === overlayKey) btn.setAttribute("aria-pressed", String(pressed));
    });
  }

  async function renderResult(result: STLDiagnosticsWorkerResult): Promise<void> {
    try {
      await ensureViewer();
      disposeCurrentModel();
      buildBaseMesh(result);
      buildOverlays(result.report);
      if (lastRadius !== null) fitCameraAndControls(lastRadius);

      renderVerdict(result.report);
      renderChecks(result.report);
      renderDetails(result.report);

      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false });
      setState("error");
    }
  }

  // --- Worker lifecycle ------------------------------------------------

  function createDiagnosticsWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/stl-diagnostics.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createDiagnosticsWorker, {
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
        lastResult = result as STLDiagnosticsWorkerResult;
        void renderResult(lastResult);
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

  // --- Report download + screenshot ------------------------------------

  function downloadReport(): void {
    if (!lastResult || !currentSession) return;
    const downloadable = buildDownloadableReport(lastResult.report, DEFAULT_STL_DIAGNOSTICS_LIMITS, currentSession.file.name, currentSession.file.size);
    const json = JSON.stringify(downloadable, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-stl-diagnostics-report.json`;
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
    summaryPanel.hidden = true;
    checksPanel.hidden = true;
    detailsPanel.hidden = true;
    cancelButton.hidden = true;
    lastRadius = null;
    lastResult = null;
    fitSelectedButton.disabled = true;
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    successConfirmation.hidden = true;

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

  cancelButton.addEventListener("click", () => workerClient?.cancel());
  resetCameraButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  fitAllButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  fitSelectedButton.addEventListener("click", () => {
    const key = fitSelectedButton.dataset.lastOverlay;
    if (key) highlightOverlay(key);
  });

  overlayToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.overlay!;
      const pressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(pressed));
      if (key === "surface" && baseMesh) baseMesh.visible = pressed;
      else if (key === "wireframe" && baseMaterial) {
        baseMaterial.wireframe = pressed;
      } else {
        const obj = overlayObjects.get(key);
        if (obj) obj.visible = pressed;
      }
      viewport?.requestRender();
    });
  });

  showAllButton.addEventListener("click", () => {
    overlayToggleButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", "true");
      const key = btn.dataset.overlay!;
      if (key === "surface" && baseMesh) baseMesh.visible = true;
      else if (key === "wireframe" && baseMaterial) baseMaterial.wireframe = true;
    });
    for (const obj of overlayObjects.values()) obj.visible = true;
    viewport?.requestRender();
  });
  hideAllButton.addEventListener("click", () => {
    overlayToggleButtons.forEach((btn) => {
      if (btn.dataset.overlay === "surface") return; // never let the user hide the base model entirely via "hide all"
      btn.setAttribute("aria-pressed", "false");
    });
    for (const [key, obj] of overlayObjects) {
      obj.visible = false;
      void key;
    }
    if (baseMaterial) baseMaterial.wireframe = false;
    viewport?.requestRender();
  });

  highlightButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.checkTarget;
      if (!key) return;
      if (key === "disconnected-shells") {
        if (lastRadius !== null) fitCameraAndControls(lastRadius);
        return;
      }
      if (key === "inward-shells" && lastResult) {
        const inward = lastResult.report.shells.find((s) => s.orientation === "inward");
        if (inward) highlightShell(inward.id);
        return;
      }
      highlightOverlay(key);
    });
  });

  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  screenshotButton.addEventListener("click", () => void exportScreenshot());
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
