/**
 * Orchestration for STL Repair — the SHARED implementation behind
 * `/stl-repair/` (primary), `/make-stl-watertight/` and
 * `/repair-non-manifold-stl/` (secondary SEO routes). Every route's own
 * `<script>` tag imports this exact module rather than duplicating any
 * of it — one repair engine, three SEO-differentiated pages around it.
 *
 * Worker lifecycle follows `stl-checker/_client.ts`'s single-persistent-
 * worker pattern (one `WorkerClient`, event callbacks bound exactly once
 * at boot) — structurally immune to the Universal Viewer's own stale-
 * generation-closure bug for the same reason `stl-checker` is: this page
 * only ever handles one format, so there is no changing concern (like a
 * format switch) for a rebound worker's callbacks to go stale against.
 * Repeated file selections instead reuse `WorkerClient`'s own
 * `requestId` matching to discard a stale in-flight response — verified
 * directly in browser testing (repeated selections, cancellation,
 * recovery, replacement mid-repair), the same way that fix originally
 * was.
 *
 * Two-phase workflow: selecting a file (or changing settings) requests
 * the worker in `mode: "plan"` — fast, mutates nothing, and is what
 * populates `STLRepairPlan` before repair ever runs. Only clicking "Run
 * repair" sends a SECOND, separate `mode: "repair"` request. This is
 * what makes "never repair automatically before the user sees the plan"
 * structurally true, not just a UI convention.
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { sanitizeDownloadBasename, buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize, formatTriangleCount } from "../../lib/stl/format";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { safePreset, standardPreset, defaultWeldTolerance, DEFAULT_REPAIR_LIMITS, type RepairPlan, type RepairResult, type RepairSettings, type SmallShellCriterion } from "../../lib/stl-repair/types";
import { buildDownloadableRepairReport } from "../../lib/stl-repair/report";
import { formatHoleSkipReason, formatOperation, formatOutcome } from "../../lib/stl-repair/formatting";
import { initBatchRepairPlanClient } from "../../lib/pro/batch-repair-plan-client";
import { createProductionEntitlementProvider } from "../../lib/pro/production-provider";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 150 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading STL…",
  "checking-original-mesh": "Checking original mesh…",
  "planning-repairs": "Planning repairs…",
  "welding-vertices": "Welding vertices…",
  "removing-invalid-faces": "Removing invalid faces…",
  "correcting-winding": "Correcting winding…",
  "filling-holes": "Filling holes…",
  "cleaning-shells": "Cleaning shells…",
  "writing-repaired-stl": "Writing repaired STL…",
  "verifying-repaired-stl": "Verifying repaired STL…",
  "preparing-comparison": "Preparing comparison…",
  complete: "Finishing up…",
};

type WorkerResultPayload = { mode: "plan"; plan: RepairPlan } | { mode: "repair"; repair: RepairResult };

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

  const presetRadios = document.querySelectorAll<HTMLInputElement>('input[name="repair-preset"]');
  const customControls = document.querySelector<HTMLFieldSetElement>("[data-custom-controls]")!;
  const analyzeButton = document.querySelector<HTMLButtonElement>('[data-action="analyze-repair-plan"]')!;

  const planPanel = document.querySelector<HTMLElement>("[data-repair-plan]")!;
  const planStepsList = document.querySelector<HTMLElement>("[data-plan-steps]")!;
  const runRepairButton = document.querySelector<HTMLButtonElement>('[data-action="run-repair"]')!;

  const resultPanel = document.querySelector<HTMLElement>("[data-repair-result]")!;
  const outcomeBadge = document.querySelector<HTMLElement>("[data-outcome-badge]")!;
  const outcomeLabel = document.querySelector<HTMLElement>("[data-outcome-label]")!;
  const outcomeDetail = document.querySelector<HTMLElement>("[data-outcome-detail]")!;
  const operationList = document.querySelector<HTMLElement>("[data-operation-list]")!;
  const unresolvedList = document.querySelector<HTMLElement>("[data-unresolved-list]")!;
  const unresolvedNone = document.querySelector<HTMLElement>("[data-unresolved-none]")!;
  const holeSkipList = document.querySelector<HTMLElement>("[data-hole-skip-list]")!;
  const repairWarnings = document.querySelector<HTMLElement>("[data-repair-warnings]")!;
  const downloadStlButton = document.querySelector<HTMLButtonElement>('[data-action="download-repaired-stl"]')!;
  const downloadReportButton = document.querySelector<HTMLButtonElement>('[data-action="download-repair-report"]')!;

  const comparisonPanel = document.querySelector<HTMLElement>("[data-repair-comparison]")!;

  const showOriginalButton = document.querySelector<HTMLButtonElement>('[data-action="show-original"]')!;
  const showRepairedButton = document.querySelector<HTMLButtonElement>('[data-action="show-repaired"]')!;
  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitModelButton = document.querySelector<HTMLButtonElement>('[data-action="fit-model"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const overlayToggleButtons = document.querySelectorAll<HTMLButtonElement>('[data-action="toggle-overlay"]');
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;

  const batchWorkspaceRoot = document.querySelector<HTMLElement>("[data-batch-workspace]");
  if (batchWorkspaceRoot) initBatchRepairPlanClient(batchWorkspaceRoot, createProductionEntitlementProvider());

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastRadius: number | null = null;
  let lastRepairResult: RepairResult | null = null;
  let showingRepaired = false;
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

  const overlayObjects = new Map<string, InstanceType<ThreeModule["Object3D"]>>();
  const overlayGeometries: InstanceType<ThreeModule["BufferGeometry"]>[] = [];
  const overlayMaterials: InstanceType<ThreeModule["Material"]>[] = [];
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

  function disposeOverlays(): void {
    if (viewport) for (const obj of overlayObjects.values()) viewport.scene.remove(obj);
    for (const g of overlayGeometries) g.dispose();
    for (const m of overlayMaterials) m.dispose();
    overlayObjects.clear();
    overlayGeometries.length = 0;
    overlayMaterials.length = 0;
  }

  function disposeCurrentModel(): void {
    if (currentMesh && viewport) viewport.scene.remove(currentMesh);
    currentGeometry?.dispose();
    currentMaterial?.dispose();
    currentMesh = null;
    currentGeometry = null;
    currentMaterial = null;
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

  function makeLineOverlay(positions: Float32Array, color: string): InstanceType<ThreeModule["LineSegments"]> | null {
    if (!THREE || positions.length === 0 || !currentMesh) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    overlayGeometries.push(geometry);
    overlayMaterials.push(material);
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 10;
    lines.position.copy(currentMesh.position);
    return lines;
  }

  function makeTriangleOverlay(positions: Float32Array, color: string): InstanceType<ThreeModule["Mesh"]> | null {
    if (!THREE || positions.length === 0 || !currentMesh) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 });
    overlayGeometries.push(geometry);
    overlayMaterials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 11;
    mesh.position.copy(currentMesh.position);
    return mesh;
  }

  function makePointOverlay(positions: Float32Array, color: string): InstanceType<ThreeModule["Points"]> | null {
    if (!THREE || positions.length === 0 || !currentMesh) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false, depthTest: false });
    overlayGeometries.push(geometry);
    overlayMaterials.push(material as unknown as InstanceType<ThreeModule["Material"]>);
    const points = new THREE.Points(geometry, material);
    points.renderOrder = 12;
    points.position.copy(currentMesh.position);
    return points;
  }

  function buildOverlaysForRepaired(result: RepairResult): void {
    if (!viewport || !result.overlays) return;
    disposeOverlays();
    const o = result.overlays;
    const entries: [string, InstanceType<ThreeModule["Object3D"]> | null][] = [
      ["removed-triangles", makeTriangleOverlay(o.removedTrianglePositions, "#e0303f")],
      ["flipped-triangles", makeTriangleOverlay(o.flippedTrianglePositions, "#c837d6")],
      ["welded-vertices", makePointOverlay(o.weldedVertexPositions, "#22c3c3")],
      ["filled-holes", makeTriangleOverlay(o.filledHolePositions, "#2ecc71")],
      ["removed-shells", makeTriangleOverlay(o.removedShellPositions, "#f5a623")],
      ["unresolved-boundary", makeLineOverlay(o.unresolvedBoundaryEdgeLines, "#ff8a3d")],
      ["unresolved-non-manifold", makeLineOverlay(o.unresolvedNonManifoldEdgeLines, "#e0303f")],
      ["unresolved-intersections", makeTriangleOverlay(o.unresolvedSelfIntersectionPositions, "#ff1f4b")],
    ];
    for (const [key, obj] of entries) {
      if (!obj) continue;
      obj.visible = false;
      viewport.scene.add(obj);
      overlayObjects.set(key, obj);
    }
    overlayToggleButtons.forEach((btn) => {
      const key = btn.dataset.overlay!;
      btn.disabled = !overlayObjects.has(key);
      btn.setAttribute("aria-pressed", "false");
    });
  }

  // --- Plan + repair request handling ------------------------------------

  function currentSettings(): RepairSettings {
    const preset = document.querySelector<HTMLInputElement>('input[name="repair-preset"]:checked')?.value ?? "safe";
    if (preset === "safe") return safePreset();
    const diagonal = lastRadius !== null ? lastRadius * 2 : 1;
    if (preset === "standard") return standardPreset(diagonal);

    // custom
    const weldEnabled = document.querySelector<HTMLInputElement>('[data-action="custom-weld-enabled"]')!.checked;
    const weldToleranceInput = document.querySelector<HTMLInputElement>('[data-action="custom-weld-tolerance"]')!;
    const weldTolerance = weldToleranceInput.value ? Number(weldToleranceInput.value) : defaultWeldTolerance(diagonal);
    const criterion = (document.querySelector<HTMLSelectElement>('[data-action="custom-small-shell-criterion"]')!.value || "triangle-count") as SmallShellCriterion;
    const thresholdInput = document.querySelector<HTMLInputElement>('[data-action="custom-small-shell-threshold"]')!;

    return {
      preset: "custom",
      weld: { enabled: weldEnabled, toleranceAbs: weldTolerance },
      removeExactDegenerates: document.querySelector<HTMLInputElement>('[data-action="custom-remove-exact-degenerates"]')!.checked,
      removeNearZeroDegenerates: document.querySelector<HTMLInputElement>('[data-action="custom-remove-near-zero-degenerates"]')!.checked,
      removeDuplicateFaces: document.querySelector<HTMLInputElement>('[data-action="custom-remove-duplicate-faces"]')!.checked,
      correctWinding: document.querySelector<HTMLInputElement>('[data-action="custom-correct-winding"]')!.checked,
      orientOutwardClosedShells: document.querySelector<HTMLInputElement>('[data-action="custom-orient-outward"]')!.checked,
      fillEligibleHoles: document.querySelector<HTMLInputElement>('[data-action="custom-fill-holes"]')!.checked,
      removeSmallShells: { enabled: document.querySelector<HTMLInputElement>('[data-action="custom-remove-small-shells"]')!.checked, criterion, threshold: thresholdInput.value ? Number(thresholdInput.value) : 0 },
    };
  }

  function renderPlan(plan: RepairPlan): void {
    planStepsList.textContent = "";
    for (const step of plan.steps) {
      const li = document.createElement("li");
      li.className = step.willRun ? "plan-step will-run" : "plan-step will-skip";
      li.textContent = `${step.willRun ? "✓" : "—"} ${formatOperation(step.operation)}: ${step.reason}`;
      planStepsList.appendChild(li);
    }
    planPanel.hidden = false;
    runRepairButton.disabled = false;
  }

  function renderRepairResult(result: RepairResult): void {
    lastRepairResult = result;
    outcomeBadge.dataset.outcome = result.outcome;
    outcomeLabel.textContent = formatOutcome(result.outcome);
    outcomeDetail.textContent = `Triangles: ${formatTriangleCount(result.trianglesBefore)} → ${formatTriangleCount(result.trianglesAfter)}. Watertight: ${result.watertightVerdictBefore} → ${result.watertightVerdictAfter ?? "—"}.`;

    operationList.textContent = "";
    for (const op of result.successfulOperations) {
      const li = document.createElement("li");
      li.textContent = `${formatOperation(op)} — applied`;
      operationList.appendChild(li);
    }
    for (const skip of result.skippedOperations) {
      const li = document.createElement("li");
      li.textContent = `${skip.operation} — skipped: ${skip.reason}`;
      operationList.appendChild(li);
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

    holeSkipList.textContent = "";
    for (const skip of result.holeFillSkips) {
      const li = document.createElement("li");
      li.textContent = `Boundary component ${skip.boundaryComponentId}: ${formatHoleSkipReason(skip.reason)}`;
      holeSkipList.appendChild(li);
    }

    repairWarnings.textContent = "";
    if (result.warnings.length > 0) {
      const ul = document.createElement("ul");
      for (const w of result.warnings) {
        const li = document.createElement("li");
        li.textContent = w.message;
        ul.appendChild(li);
      }
      repairWarnings.appendChild(ul);
      repairWarnings.hidden = false;
    } else {
      repairWarnings.hidden = true;
    }

    const set = (selector: string, text: string) => {
      const el = comparisonPanel.querySelector<HTMLElement>(selector);
      if (el) el.textContent = text;
    };
    set("[data-compare-verdict-before]", result.watertightVerdictBefore);
    set("[data-compare-verdict-after]", result.watertightVerdictAfter ?? "—");
    set("[data-compare-triangles-before]", formatTriangleCount(result.trianglesBefore));
    set("[data-compare-triangles-after]", formatTriangleCount(result.trianglesAfter));
    set("[data-compare-vertices-before]", formatTriangleCount(result.verticesBefore));
    set("[data-compare-vertices-after]", formatTriangleCount(result.verticesAfter));
    set("[data-compare-shells-before]", formatTriangleCount(result.before.shellCount));
    set("[data-compare-shells-after]", result.after ? formatTriangleCount(result.after.shellCount) : "—");
    set("[data-compare-boundary-before]", formatTriangleCount(result.boundaryEdgesBefore));
    set("[data-compare-boundary-after]", formatTriangleCount(result.boundaryEdgesAfter));
    set("[data-compare-nonmanifold-before]", formatTriangleCount(result.nonManifoldEdgesBefore));
    set("[data-compare-nonmanifold-after]", formatTriangleCount(result.nonManifoldEdgesAfter));
    set("[data-compare-winding-before]", formatTriangleCount(result.windingConflictsBefore));
    set("[data-compare-winding-after]", formatTriangleCount(result.windingConflictsAfter));
    set("[data-compare-selfintersect-before]", result.selfIntersectionStatusBefore === "completed" ? formatTriangleCount(result.before.selfIntersectionCount) : "not checked");
    set("[data-compare-selfintersect-after]", result.selfIntersectionStatusAfter === "completed" ? formatTriangleCount(result.after?.selfIntersectionCount ?? 0) : result.selfIntersectionStatusAfter === "not-checked" ? "not checked" : "—");

    resultPanel.hidden = false;
    comparisonPanel.hidden = false;
    downloadStlButton.disabled = !result.outputBytes;
    downloadReportButton.disabled = !result.outputBytes;
    showRepairedButton.disabled = !result.outputBytes;

    if (result.outputBytes) {
      try {
        const parsed = parseRepairedSTLForDisplay(result.outputBytes);
        if (parsed) {
          void ensureViewer().then(() => {
            buildOverlaysForRepaired(result);
          });
        }
      } catch {
        // Display-only best-effort; the download itself is unaffected.
      }
    }
  }

  let repairedPositions: Float32Array | null = null;
  let repairedNormals: Float32Array | null = null;

  function parseRepairedSTLForDisplay(bytes: ArrayBuffer): boolean {
    // Lightweight re-parse purely for the in-page preview toggle — the
    // worker already re-parsed and re-diagnosed this exact buffer as
    // part of verification; this second, main-thread parse only
    // extracts renderable geometry, never re-decides correctness.
    try {
      // Re-use the same binary STL layout directly rather than importing
      // the full parser bundle onto the main thread a second time.
      const view = new DataView(bytes);
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
      repairedPositions = positions;
      repairedNormals = normals;
      return true;
    } catch {
      return false;
    }
  }

  function showModel(which: "original" | "repaired"): void {
    if (!viewport) return;
    showingRepaired = which === "repaired";
    showOriginalButton.setAttribute("aria-pressed", String(!showingRepaired));
    showRepairedButton.setAttribute("aria-pressed", String(showingRepaired));
    const positions = showingRepaired ? repairedPositions : originalPositions;
    const normals = showingRepaired ? repairedNormals : originalNormals;
    if (!positions || !normals) return;
    buildMesh(positions, normals);
    if (lastRepairResult && showingRepaired) buildOverlaysForRepaired(lastRepairResult);
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  }

  // --- Worker lifecycle ------------------------------------------------

  function createRepairWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/stl-repair.worker.ts", import.meta.url), { type: "module" });
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

  async function requestRepair(): Promise<void> {
    if (!currentSession || !workerClient || !workerReady) return;
    hideError();
    setState("processing");
    runRepairButton.disabled = true;
    try {
      const buffer = await currentSession.readArrayBuffer();
      originalPositions = null; // will be reconstructed after we have originalStl below via a parse
      workerClient.process(currentSession.file.name, currentSession.extension, buffer, { mode: "repair", settings: currentSettings() });
    } catch (error) {
      if (isSafeError(error)) showError(error);
      setState("error");
    }
  }

  async function initWorker(): Promise<void> {
    workerReady = false;
    workerClient = new WorkerClient(createRepairWorker, {
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
          setState("success");
          successConfirmation.hidden = false;
        } else {
          renderRepairResult(payload.repair);
          setState("success");
          successConfirmation.hidden = false;
        }
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

  function downloadRepairedStl(): void {
    if (!lastRepairResult?.outputBytes || !currentSession) return;
    const blob = new Blob([lastRepairResult.outputBytes], { type: "model/stl" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-repaired.stl`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadReport(): void {
    if (!lastRepairResult || !currentSession) return;
    const downloadable = buildDownloadableRepairReport(lastRepairResult, DEFAULT_REPAIR_LIMITS, currentSession.file.name, currentSession.file.size);
    const json = JSON.stringify(downloadable, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-repair-report.json`;
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
    lastRepairResult = null;
    originalPositions = null;
    originalNormals = null;
    repairedPositions = null;
    repairedNormals = null;
    runRepairButton.disabled = true;
    downloadStlButton.disabled = true;
    downloadReportButton.disabled = true;
    showRepairedButton.disabled = true;
    showModelReset();
    setState("idle");
  }

  function showModelReset(): void {
    showingRepaired = false;
    showOriginalButton.setAttribute("aria-pressed", "true");
    showRepairedButton.setAttribute("aria-pressed", "false");
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
      // Build the original-model viewport immediately from a local parse
      // (display-only) so the user has something to look at while the
      // worker's own plan request is in flight.
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
      // Binary-STL fast path only, for the immediate preview; if this
      // isn't binary STL, the worker's own real parser (which handles
      // both encodings) still drives the authoritative plan/repair
      // result — this local parse is display-convenience only.
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

  presetRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      customControls.disabled = radio.value !== "custom";
      customControls.querySelectorAll("input, select").forEach((el) => {
        (el as HTMLInputElement | HTMLSelectElement).disabled = radio.value !== "custom";
      });
      planPanel.hidden = true;
      runRepairButton.disabled = true;
    });
  });

  analyzeButton.addEventListener("click", () => void requestPlan());
  runRepairButton.addEventListener("click", () => void requestRepair());

  showOriginalButton.addEventListener("click", () => showModel("original"));
  showRepairedButton.addEventListener("click", () => showModel("repaired"));
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

  overlayToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.overlay!;
      const pressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(pressed));
      const obj = overlayObjects.get(key);
      if (obj) obj.visible = pressed;
      viewport?.requestRender();
    });
  });

  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  screenshotButton.addEventListener("click", () => void exportScreenshot());
  downloadStlButton.addEventListener("click", downloadRepairedStl);
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
