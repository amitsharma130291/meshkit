/**
 * Orchestration for /3mf-viewer/. Follows the same shape as
 * src/pages/obj-viewer/_client.ts (lazy Three.js viewport, camera fit with
 * OrbitControls damping cleared before repositioning, worker lifecycle,
 * index-buffer segment visibility, fit-visible via precomputed per-segment
 * bounds) — see that file for the reasoning shared with it. What's new
 * here: a real Build → build item → component instance → mesh object
 * hierarchy instead of OBJ's object/group heuristic, a declared-unit +
 * millimeter dual display (3MF actually has a unit, unlike OBJ/STL), a
 * color-mode select (embedded package colors / neutral / deterministic
 * color-by-object) instead of a shading toggle, and a metadata panel.
 *
 * Runs only when `document` exists — see the foundation-preview client for
 * why (Astro's static build imports client scripts into its server module
 * graph to resolve bundled asset URLs).
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize, formatMagnitude, formatTriangleCount } from "../../lib/stl/format";
import type { STLBounds } from "../../lib/stl/types";
import { srgbChannelToLinear } from "../../lib/threemf/viewer-colors";
import { buildSegmentStructuralLabel, formatMetadataLabel } from "../../lib/threemf/viewer-formatting";
import type { ThreeMFUnit } from "../../lib/threemf/types";
import type { ThreeMFViewerResult, ThreeMFViewerSegment, ThreeMFViewerWarning } from "../../lib/threemf/viewer-types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
type ColorMode = "embedded" | "neutral" | "object";

const MAX_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_RENDERED_SEGMENT_ROWS = 150;

const STAGE_LABELS: Record<string, string> = {
  "reading-package": "Reading package…",
  "validating-package": "Validating package…",
  "locating-model": "Locating model…",
  "parsing-model": "Parsing model…",
  "reading-resources": "Reading colors and materials…",
  "resolving-components": "Resolving components…",
  "building-scene": "Building scene…",
  "building-colors": "Preparing colors…",
  complete: "Finishing up…",
};

const UNIT_LABELS: Record<ThreeMFUnit, string> = {
  micron: "µm",
  millimeter: "mm",
  centimeter: "cm",
  inch: "in",
  foot: "ft",
  meter: "m",
};

const OBJECT_COLOR_PALETTE = ["#6d42f5", "#24b8d8", "#ed4b93", "#f5a623", "#2ecc71", "#e74c3c", "#9b59b6", "#1abc9c", "#f39c12", "#34495e"];

function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = (h * 33 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [srgbChannelToLinear(((n >> 16) & 0xff) / 255), srgbChannelToLinear(((n >> 8) & 0xff) / 255), srgbChannelToLinear((n & 0xff) / 255)];
}

function unionBounds(list: STLBounds[]): STLBounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const bounds of list) {
    if (bounds.min[0] < minX) minX = bounds.min[0];
    if (bounds.min[1] < minY) minY = bounds.min[1];
    if (bounds.min[2] < minZ) minZ = bounds.min[2];
    if (bounds.max[0] > maxX) maxX = bounds.max[0];
    if (bounds.max[1] > maxY) maxY = bounds.max[1];
    if (bounds.max[2] > maxZ) maxZ = bounds.max[2];
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

function boundsRadius(bounds: STLBounds): number {
  const [sx, sy, sz] = bounds.size;
  return Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6);
}

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
  const infoEntryCount = document.querySelector<HTMLElement>("[data-info-entry-count]")!;
  const infoUnit = document.querySelector<HTMLElement>("[data-info-unit]")!;
  const infoUnitScale = document.querySelector<HTMLElement>("[data-info-unit-scale]")!;
  const infoWidthDeclared = document.querySelector<HTMLElement>("[data-info-width-declared]")!;
  const infoHeightDeclared = document.querySelector<HTMLElement>("[data-info-height-declared]")!;
  const infoDepthDeclared = document.querySelector<HTMLElement>("[data-info-depth-declared]")!;
  const infoWidthMm = document.querySelector<HTMLElement>("[data-info-width-mm]")!;
  const infoHeightMm = document.querySelector<HTMLElement>("[data-info-height-mm]")!;
  const infoDepthMm = document.querySelector<HTMLElement>("[data-info-depth-mm]")!;
  const infoBboxMin = document.querySelector<HTMLElement>("[data-info-bbox-min]")!;
  const infoBboxMax = document.querySelector<HTMLElement>("[data-info-bbox-max]")!;
  const infoMeshObjects = document.querySelector<HTMLElement>("[data-info-mesh-objects]")!;
  const infoComponentObjects = document.querySelector<HTMLElement>("[data-info-component-objects]")!;
  const infoBuildItems = document.querySelector<HTMLElement>("[data-info-build-items]")!;
  const infoResolvedInstances = document.querySelector<HTMLElement>("[data-info-resolved-instances]")!;
  const infoSourceVertices = document.querySelector<HTMLElement>("[data-info-source-vertices]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoBaseMaterials = document.querySelector<HTMLElement>("[data-info-base-materials]")!;
  const infoColorGroups = document.querySelector<HTMLElement>("[data-info-color-groups]")!;
  const infoTextureResources = document.querySelector<HTMLElement>("[data-info-texture-resources]")!;
  const infoMetadataCount = document.querySelector<HTMLElement>("[data-info-metadata-count]")!;
  const infoWarnings = document.querySelector<HTMLElement>("[data-info-warnings]")!;

  const sceneTree = document.querySelector<HTMLElement>("[data-scene-tree]")!;
  const sceneTreeNote = document.querySelector<HTMLElement>("[data-scene-tree-note]")!;
  const sceneTreeList = document.querySelector<HTMLElement>("[data-scene-tree-list]")!;
  const showAllButton = document.querySelector<HTMLButtonElement>('[data-action="show-all-segments"]')!;
  const hideAllButton = document.querySelector<HTMLButtonElement>('[data-action="hide-all-segments"]')!;

  const metadataPanel = document.querySelector<HTMLElement>("[data-metadata-panel]")!;
  const metadataList = document.querySelector<HTMLElement>("[data-metadata-list]")!;
  const metadataEmpty = document.querySelector<HTMLElement>("[data-metadata-empty]")!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitVisibleButton = document.querySelector<HTMLButtonElement>('[data-action="fit-visible"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const colorModeSelect = document.querySelector<HTMLSelectElement>('[data-action="color-mode"]')!;
  const colorModeNote = document.querySelector<HTMLElement>("[data-color-mode-note]")!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastResult: ThreeMFViewerResult | null = null;
  let lastFullRadius: number | null = null;
  let hiddenSegmentIndices = new Set<number>();
  let colorMode: ColorMode = "neutral";
  let objectColorArrayCache: Float32Array | null = null;
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let currentMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let currentGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
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
    objectColorArrayCache = null;

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
    if (!lastResult) return;
    const boundsList: STLBounds[] = [];
    lastResult.segments.forEach((segment, index) => {
      if (!hiddenSegmentIndices.has(index)) boundsList.push(segment.bounds);
    });
    const combined = unionBounds(boundsList);
    if (!combined) return;

    const fullCenter = lastResult.boundsMillimeters.center;
    const worldCenter: [number, number, number] = [
      combined.center[0] - fullCenter[0],
      combined.center[1] - fullCenter[1],
      combined.center[2] - fullCenter[2],
    ];
    fitCameraAndControls(boundsRadius(combined), worldCenter);
  }

  function rebuildVisibleIndex(): void {
    if (!currentGeometry || !lastResult || !THREE) return;
    const segments = lastResult.segments;

    if (hiddenSegmentIndices.size === 0) {
      currentGeometry.setIndex(null);
      currentGeometry.setDrawRange(0, Infinity);
      viewport?.requestRender();
      return;
    }

    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      if (!hiddenSegmentIndices.has(i)) total += segments[i].triangleCount * 3;
    }
    const index = new Uint32Array(total);
    let offset = 0;
    for (let i = 0; i < segments.length; i++) {
      if (hiddenSegmentIndices.has(i)) continue;
      const segment = segments[i];
      const start = segment.triangleStart * 3;
      const count = segment.triangleCount * 3;
      for (let k = 0; k < count; k++) index[offset + k] = start + k;
      offset += count;
    }
    currentGeometry.setIndex(new THREE.BufferAttribute(index, 1));
    currentGeometry.setDrawRange(0, index.length);
    viewport?.requestRender();
  }

  function buildObjectColorArray(result: ThreeMFViewerResult): Float32Array {
    const array = new Float32Array(result.triangleCount * 9);
    const linearByObject = new Map<string, [number, number, number]>();
    for (const segment of result.segments) {
      let linear = linearByObject.get(segment.meshObjectId);
      if (!linear) {
        const hex = OBJECT_COLOR_PALETTE[hashString(segment.meshObjectId) % OBJECT_COLOR_PALETTE.length];
        linear = hexToLinear(hex);
        linearByObject.set(segment.meshObjectId, linear);
      }
      const base = segment.triangleStart * 9;
      const end = base + segment.triangleCount * 9;
      for (let i = base; i < end; i += 3) {
        array[i] = linear[0];
        array[i + 1] = linear[1];
        array[i + 2] = linear[2];
      }
    }
    return array;
  }

  function applyColorMode(): void {
    if (!currentGeometry || !currentMaterial || !THREE || !lastResult) return;

    if (colorMode === "neutral") {
      currentMaterial.vertexColors = false;
      currentMaterial.color.set(currentColorHex);
    } else if (colorMode === "embedded" && lastResult.colors) {
      currentMaterial.vertexColors = true;
      currentMaterial.color.set("#ffffff");
      currentGeometry.setAttribute("color", new THREE.BufferAttribute(lastResult.colors, 3));
    } else if (colorMode === "object") {
      if (!objectColorArrayCache) objectColorArrayCache = buildObjectColorArray(lastResult);
      currentMaterial.vertexColors = true;
      currentMaterial.color.set("#ffffff");
      currentGeometry.setAttribute("color", new THREE.BufferAttribute(objectColorArrayCache, 3));
    }
    currentMaterial.needsUpdate = true;
    viewport?.requestRender();
  }

  function setupColorModeControl(result: ThreeMFViewerResult): void {
    const embeddedOption = colorModeSelect.querySelector<HTMLOptionElement>('option[value="embedded"]');
    if (embeddedOption) embeddedOption.disabled = !result.hasEmbeddedColors;
    colorMode = result.hasEmbeddedColors ? "embedded" : "neutral";
    colorModeSelect.value = colorMode;
    if (!result.hasEmbeddedColors) {
      colorModeNote.hidden = false;
      colorModeNote.textContent = "This file has no supported embedded color data, so embedded-color mode isn't available.";
    } else {
      colorModeNote.hidden = true;
      colorModeNote.textContent = "";
    }
  }

  function buildSceneFromResult(result: ThreeMFViewerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));

    const material = new THREE.MeshStandardMaterial({
      color: currentColorHex,
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      wireframe: currentWireframe,
    });

    const mesh = new THREE.Mesh(geometry, material);
    const fullCenter = result.boundsMillimeters.center;
    mesh.position.set(-fullCenter[0], -fullCenter[1], -fullCenter[2]);
    viewport.scene.add(mesh);

    currentMesh = mesh;
    currentGeometry = geometry;
    currentMaterial = material;

    hiddenSegmentIndices.clear();
    rebuildVisibleIndex();
    applyColorMode();

    lastFullRadius = boundsRadius(result.boundsMillimeters);
    const helperSize = Math.max(lastFullRadius * 4, 2);
    const grid = new THREE.GridHelper(helperSize, 20, 0x6d42f5, 0xd8d3f0);
    grid.visible = gridVisible;
    viewport.scene.add(grid);
    currentGridHelper = grid;

    const axes = new THREE.AxesHelper(helperSize / 2);
    axes.visible = axesVisible;
    viewport.scene.add(axes);
    currentAxesHelper = axes;

    fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  }

  function renderBounds(result: ThreeMFViewerResult): void {
    const bounds = result.boundsMillimeters;
    const scale = result.millimeterScale;
    const unitLabel = UNIT_LABELS[result.declaredUnit];

    infoWidthDeclared.textContent = `${formatMagnitude(bounds.size[0] / scale)} ${unitLabel}`;
    infoHeightDeclared.textContent = `${formatMagnitude(bounds.size[1] / scale)} ${unitLabel}`;
    infoDepthDeclared.textContent = `${formatMagnitude(bounds.size[2] / scale)} ${unitLabel}`;
    infoWidthMm.textContent = `${formatMagnitude(bounds.size[0])} mm`;
    infoHeightMm.textContent = `${formatMagnitude(bounds.size[1])} mm`;
    infoDepthMm.textContent = `${formatMagnitude(bounds.size[2])} mm`;
    infoBboxMin.textContent = `(${bounds.min.map(formatMagnitude).join(", ")}) mm`;
    infoBboxMax.textContent = `(${bounds.max.map(formatMagnitude).join(", ")}) mm`;
  }

  function renderWarnings(warnings: ThreeMFViewerWarning[]): void {
    if (warnings.length === 0) {
      infoWarnings.hidden = true;
      infoWarnings.textContent = "";
      return;
    }
    infoWarnings.hidden = false;
    infoWarnings.textContent = "";
    const heading = document.createElement("p");
    heading.textContent = "Things to know about this file:";
    infoWarnings.appendChild(heading);
    const list = document.createElement("ul");
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning.message;
      list.appendChild(item);
    }
    infoWarnings.appendChild(list);
  }

  function renderInfo(result: ThreeMFViewerResult): void {
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoEntryCount.textContent = String(result.packageEntryCount);
    infoUnit.textContent = result.declaredUnit.charAt(0).toUpperCase() + result.declaredUnit.slice(1);
    infoUnitScale.textContent = `× ${formatMagnitude(result.millimeterScale)} mm`;
    renderBounds(result);
    infoMeshObjects.textContent = String(result.meshObjectCount);
    infoComponentObjects.textContent = String(result.componentObjectCount);
    infoBuildItems.textContent = String(result.buildItemCount);
    infoResolvedInstances.textContent = formatTriangleCount(result.resolvedInstanceCount);
    infoSourceVertices.textContent = formatTriangleCount(result.sourceVertexCount);
    infoTriangles.textContent = formatTriangleCount(result.triangleCount);
    infoBaseMaterials.textContent = `${result.colorResources.baseMaterialGroupCount} (${result.colorResources.baseMaterialEntryCount} colors)`;
    infoColorGroups.textContent = `${result.colorResources.colorGroupCount} (${result.colorResources.colorEntryCount} colors)`;
    infoTextureResources.textContent = String(result.colorResources.textureResourceCount);
    infoMetadataCount.textContent = String(result.metadata.length);

    renderWarnings(result.warnings);
    modelInfo.hidden = false;
  }

  function renderMetadata(result: ThreeMFViewerResult): void {
    metadataPanel.hidden = false;
    metadataList.textContent = "";
    if (result.metadata.length === 0) {
      metadataEmpty.hidden = false;
      return;
    }
    metadataEmpty.hidden = true;
    for (const entry of result.metadata) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = formatMetadataLabel(entry.name || "Metadata");
      const dd = document.createElement("dd");
      dd.textContent = entry.value.length > 0 ? entry.value : "—";
      row.append(dt, dd);
      metadataList.appendChild(row);
    }
  }

  function renderSceneTree(result: ThreeMFViewerResult): void {
    sceneTree.hidden = false;
    sceneTreeList.textContent = "";

    const segments = result.segments;
    const rendered = segments.slice(0, MAX_RENDERED_SEGMENT_ROWS);
    const overflow = segments.length - rendered.length;

    sceneTreeNote.textContent =
      overflow > 0
        ? `Showing ${rendered.length} of ${segments.length} instances individually. "Show all" and "Hide all" apply to every one.`
        : `${segments.length} resolved ${segments.length === 1 ? "instance" : "instances"}.`;

    const buildItemOrder: number[] = [];
    const byBuildItem = new Map<number, { segment: ThreeMFViewerSegment; index: number }[]>();
    rendered.forEach((segment, index) => {
      if (!byBuildItem.has(segment.buildItemIndex)) {
        byBuildItem.set(segment.buildItemIndex, []);
        buildItemOrder.push(segment.buildItemIndex);
      }
      byBuildItem.get(segment.buildItemIndex)!.push({ segment, index });
    });

    for (const buildItemIndex of buildItemOrder) {
      const wrap = document.createElement("div");
      wrap.className = "scene-tree-object-group";
      const heading = document.createElement("p");
      heading.className = "scene-tree-object-name";
      heading.textContent = `Build item ${buildItemIndex + 1}`;
      wrap.appendChild(heading);

      for (const { segment, index } of byBuildItem.get(buildItemIndex)!) {
        const row = document.createElement("div");
        row.className = "scene-tree-row";

        const checkboxId = `threemf-viewer-segment-${index}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = checkboxId;
        checkbox.checked = !hiddenSegmentIndices.has(index);
        const structuralLabel = buildSegmentStructuralLabel(segment.buildItemIndex, segment.componentPath, segment.meshObjectId);
        checkbox.setAttribute("aria-label", `Show ${segment.displayName ?? structuralLabel}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenSegmentIndices.delete(index);
          else hiddenSegmentIndices.add(index);
          rebuildVisibleIndex();
        });

        const label = document.createElement("label");
        label.className = "scene-tree-row-label";
        label.setAttribute("for", checkboxId);
        const colorText = segment.colorResourceRef ? ` · ${segment.colorResourceRef}` : "";
        label.textContent = `${segment.displayName ?? structuralLabel}${colorText}`;

        const count = document.createElement("span");
        count.className = "scene-tree-row-count";
        count.textContent = formatTriangleCount(segment.triangleCount);

        const isolateButton = document.createElement("button");
        isolateButton.type = "button";
        isolateButton.className = "scene-tree-isolate";
        isolateButton.textContent = "Isolate";
        isolateButton.addEventListener("click", () => {
          hiddenSegmentIndices = new Set(segments.map((_, segmentIndex) => segmentIndex).filter((segmentIndex) => segmentIndex !== index));
          rebuildVisibleIndex();
          renderSceneTree(result);
        });

        row.append(checkbox, label, count, isolateButton);
        wrap.appendChild(row);
      }

      sceneTreeList.appendChild(wrap);
    }
  }

  async function renderResult(result: ThreeMFViewerResult): Promise<void> {
    try {
      await ensureViewer();
      lastResult = result;

      setupColorModeControl(result);
      buildSceneFromResult(result);
      renderInfo(result);
      renderMetadata(result);
      renderSceneTree(result);

      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(
        isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false },
      );
      setState("error");
    }
  }

  function createThreeMFViewerWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/threemf-viewer.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createThreeMFViewerWorker, {
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
        void renderResult(result as ThreeMFViewerResult);
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

  function resetResultsUI(): void {
    successConfirmation.hidden = true;
    modelInfo.hidden = true;
    sceneTree.hidden = true;
    sceneTreeList.textContent = "";
    metadataPanel.hidden = true;
    metadataList.textContent = "";
    infoWarnings.hidden = true;
    infoWarnings.textContent = "";
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
    lastResult = null;
    lastFullRadius = null;
    hiddenSegmentIndices = new Set();
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    resetResultsUI();

    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = { allowedExtensions: ["3mf"], maxSizeBytes: MAX_SIZE_BYTES };
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
    if (lastFullRadius !== null) fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  });
  fitAllButton.addEventListener("click", () => {
    if (lastFullRadius !== null) fitCameraAndControls(lastFullRadius, [0, 0, 0]);
  });
  fitVisibleButton.addEventListener("click", fitVisible);

  wireframeButton.addEventListener("click", () => {
    currentWireframe = !currentWireframe;
    wireframeButton.setAttribute("aria-pressed", String(currentWireframe));
    if (currentMaterial) {
      currentMaterial.wireframe = currentWireframe;
      viewport?.requestRender();
    }
  });

  colorModeSelect.addEventListener("change", () => {
    const value = colorModeSelect.value;
    colorMode = value === "embedded" || value === "object" ? value : "neutral";
    applyColorMode();
  });

  colorSelect.addEventListener("change", () => {
    currentColorHex = colorSelect.value;
    if (colorMode === "neutral" && currentMaterial) {
      currentMaterial.color.set(currentColorHex);
      viewport?.requestRender();
    }
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
    hiddenSegmentIndices.clear();
    rebuildVisibleIndex();
    if (lastResult) renderSceneTree(lastResult);
  });
  hideAllButton.addEventListener("click", () => {
    if (!lastResult) return;
    hiddenSegmentIndices = new Set(lastResult.segments.map((_, index) => index));
    rebuildVisibleIndex();
    renderSceneTree(lastResult);
  });

  screenshotButton.addEventListener("click", () => {
    void exportScreenshot();
  });
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
