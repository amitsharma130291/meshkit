/**
 * Orchestration for /ply-viewer/. Follows the same overall shape as
 * src/pages/glb-viewer/_client.ts (lazy Three.js viewport, camera fit with
 * OrbitControls damping cleared before repositioning, worker lifecycle) —
 * see that file for the reasoning shared with it. What's different here:
 * PLY has no scene graph, so there's no per-segment index rebuild at all.
 * Surface/edges/points are three independent Object3Ds — a Mesh, a
 * LineSegments and a Points — that each read from the *same* shared
 * position/color/normal `BufferAttribute` instances (never duplicated),
 * with visibility toggled via each object's own `.visible` flag rather
 * than an index rebuild, since PLY has no sub-category granularity to
 * toggle within "surface" or "points". Sharing a `BufferAttribute` across
 * multiple `BufferGeometry`s is safe here specifically because all of a
 * loaded model's geometries are always disposed together, as one atomic
 * group, in `disposeCurrentModel()` — never one at a time while a sibling
 * geometry referencing the same attribute is still being rendered, which
 * is the scenario where Three.js's per-geometry GPU-buffer release would
 * otherwise pull a buffer out from under a still-live geometry.
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
import type { PLYRenderCategory, PLYViewerResult, PLYViewerWarning } from "../../lib/ply/viewer-types";
import type { PLYFormat } from "../../lib/ply/types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
type ColorMode = "vertex-colors" | "neutral";
type ShadingMode = "smooth" | "flat";

const MAX_SIZE_BYTES = 150 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  "reading-header": "Reading header…",
  "validating-schema": "Validating schema…",
  "reading-geometry": "Reading geometry…",
  "building-geometry": "Building geometry…",
  complete: "Finishing up…",
};

const ENCODING_LABELS: Record<PLYFormat, string> = {
  ascii: "ASCII",
  binary_little_endian: "Binary (little-endian)",
  binary_big_endian: "Binary (big-endian)",
};

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
  const infoEncoding = document.querySelector<HTMLElement>("[data-info-encoding]")!;
  const infoVertices = document.querySelector<HTMLElement>("[data-info-vertices]")!;
  const infoSourceFaces = document.querySelector<HTMLElement>("[data-info-source-faces]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoEdges = document.querySelector<HTMLElement>("[data-info-edges]")!;
  const infoPoints = document.querySelector<HTMLElement>("[data-info-points]")!;
  const infoVertexProperties = document.querySelector<HTMLElement>("[data-info-vertex-properties]")!;
  const infoFaceProperties = document.querySelector<HTMLElement>("[data-info-face-properties]")!;
  const infoComments = document.querySelector<HTMLElement>("[data-info-comments]")!;
  const infoObjInfo = document.querySelector<HTMLElement>("[data-info-obj-info]")!;
  const infoUnknownElements = document.querySelector<HTMLElement>("[data-info-unknown-elements]")!;
  const infoUnknownProperties = document.querySelector<HTMLElement>("[data-info-unknown-properties]")!;
  const infoSourceNormals = document.querySelector<HTMLElement>("[data-info-source-normals]")!;
  const infoVertexColors = document.querySelector<HTMLElement>("[data-info-vertex-colors]")!;
  const infoAlpha = document.querySelector<HTMLElement>("[data-info-alpha]")!;
  const infoTexcoords = document.querySelector<HTMLElement>("[data-info-texcoords]")!;
  const infoTexcoordsNote = document.querySelector<HTMLElement>("[data-info-texcoords-note]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const infoWarnings = document.querySelector<HTMLElement>("[data-info-warnings]")!;

  const geometryPanel = document.querySelector<HTMLElement>("[data-geometry-panel]")!;
  const geometryNote = document.querySelector<HTMLElement>("[data-geometry-note]")!;
  const geometryList = document.querySelector<HTMLElement>("[data-geometry-list]")!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitVisibleButton = document.querySelector<HTMLButtonElement>('[data-action="fit-visible"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const colorModeField = document.querySelector<HTMLElement>('[data-control="color-mode"]')!;
  const colorModeSelect = document.querySelector<HTMLSelectElement>('[data-action="color-mode"]')!;
  const shadingField = document.querySelector<HTMLElement>('[data-control="shading"]')!;
  const shadingSelect = document.querySelector<HTMLSelectElement>('[data-action="shading-mode"]')!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const pointSizeField = document.querySelector<HTMLElement>('[data-control="point-size"]')!;
  const pointSizeInput = document.querySelector<HTMLInputElement>('[data-action="point-size"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastResult: PLYViewerResult | null = null;
  let lastFullRadius: number | null = null;
  let colorMode: ColorMode = "vertex-colors";
  let shadingMode: ShadingMode = "smooth";
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";
  let pointSizePx = Number(pointSizeInput.value) || 4;
  let surfaceVisible = true;
  let edgesVisible = true;
  let pointsVisible = true;
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;

  let sharedPositionAttr: InstanceType<ThreeModule["BufferAttribute"]> | null = null;
  let sharedColorAttr: InstanceType<ThreeModule["BufferAttribute"]> | null = null;
  let sharedNormalAttr: InstanceType<ThreeModule["BufferAttribute"]> | null = null;

  let surfaceMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let surfaceGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let surfaceMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;

  let edgesObj: InstanceType<ThreeModule["LineSegments"]> | null = null;
  let edgesGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let edgesMaterial: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;

  let pointsObj: InstanceType<ThreeModule["Points"]> | null = null;
  let pointsGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let pointsMaterial: InstanceType<ThreeModule["PointsMaterial"]> | null = null;

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
    if (surfaceMesh && viewport) viewport.scene.remove(surfaceMesh);
    surfaceGeometry?.dispose();
    surfaceMaterial?.dispose();
    surfaceMesh = null;
    surfaceGeometry = null;
    surfaceMaterial = null;

    if (edgesObj && viewport) viewport.scene.remove(edgesObj);
    edgesGeometry?.dispose();
    edgesMaterial?.dispose();
    edgesObj = null;
    edgesGeometry = null;
    edgesMaterial = null;

    if (pointsObj && viewport) viewport.scene.remove(pointsObj);
    pointsGeometry?.dispose();
    pointsMaterial?.dispose();
    pointsObj = null;
    pointsGeometry = null;
    pointsMaterial = null;

    sharedPositionAttr = null;
    sharedColorAttr = null;
    sharedNormalAttr = null;

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
      preserveDrawingBuffer: true,
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
    if (surfaceVisible && lastResult.boundsSurface) boundsList.push(lastResult.boundsSurface);
    if (edgesVisible && lastResult.boundsEdges) boundsList.push(lastResult.boundsEdges);
    if (pointsVisible && lastResult.boundsPoints) boundsList.push(lastResult.boundsPoints);
    if (boundsList.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const b of boundsList) {
      if (b.min[0] < minX) minX = b.min[0];
      if (b.min[1] < minY) minY = b.min[1];
      if (b.min[2] < minZ) minZ = b.min[2];
      if (b.max[0] > maxX) maxX = b.max[0];
      if (b.max[1] > maxY) maxY = b.max[1];
      if (b.max[2] > maxZ) maxZ = b.max[2];
    }
    const combined: STLBounds = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    };
    fitCameraAndControls(boundsRadius(combined), combined.center);
  }

  // --- Materials and shading ---

  function applyColorMode(): void {
    const useVertexColors = colorMode === "vertex-colors" && Boolean(sharedColorAttr);
    if (surfaceMaterial) {
      surfaceMaterial.vertexColors = useVertexColors;
      surfaceMaterial.color.set(currentColorHex);
      surfaceMaterial.needsUpdate = true;
    }
    if (edgesMaterial) {
      edgesMaterial.vertexColors = useVertexColors;
      edgesMaterial.color.set(currentColorHex);
      edgesMaterial.needsUpdate = true;
    }
    if (pointsMaterial) {
      pointsMaterial.vertexColors = useVertexColors;
      pointsMaterial.color.set(currentColorHex);
      pointsMaterial.needsUpdate = true;
    }
    viewport?.requestRender();
  }

  function applyShadingMode(): void {
    if (surfaceMaterial) {
      surfaceMaterial.flatShading = shadingMode === "flat";
      surfaceMaterial.needsUpdate = true;
    }
    viewport?.requestRender();
  }

  function applyWireframe(): void {
    if (surfaceMaterial) {
      surfaceMaterial.wireframe = currentWireframe;
      viewport?.requestRender();
    }
  }

  function applyPointSize(): void {
    if (pointsMaterial) {
      pointsMaterial.size = pointSizePx;
      viewport?.requestRender();
    }
  }

  function setupDisplayControls(result: PLYViewerResult): void {
    const hasSurface = Boolean(result.surfaceIndices);
    const hasEdges = Boolean(result.edgeIndices);
    const hasColors = result.hasVertexColors;

    shadingMode = "smooth";
    shadingSelect.value = shadingMode;
    shadingField.hidden = !hasSurface;

    colorMode = hasColors ? "vertex-colors" : "neutral";
    colorModeSelect.value = colorMode;
    const vertexColorOption = colorModeSelect.querySelector<HTMLOptionElement>('option[value="vertex-colors"]');
    if (vertexColorOption) vertexColorOption.disabled = !hasColors;
    colorModeField.hidden = !hasColors;

    wireframeButton.hidden = !hasSurface;
    wireframeButton.setAttribute("aria-pressed", "false");
    currentWireframe = false;

    pointSizeField.hidden = false;

    surfaceVisible = true;
    edgesVisible = true;
    pointsVisible = true;
    void hasEdges;
  }

  function buildSceneFromResult(result: PLYViewerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    sharedPositionAttr = new THREE.BufferAttribute(result.positions, 3);
    sharedColorAttr = result.colors ? new THREE.BufferAttribute(result.colors, 4) : null;
    sharedNormalAttr = result.normals ? new THREE.BufferAttribute(result.normals, 3) : null;

    if (result.surfaceIndices) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", sharedPositionAttr);
      if (sharedNormalAttr) geometry.setAttribute("normal", sharedNormalAttr);
      if (sharedColorAttr) geometry.setAttribute("color", sharedColorAttr);
      geometry.setIndex(new THREE.BufferAttribute(result.surfaceIndices, 1));

      const material = new THREE.MeshStandardMaterial({
        color: currentColorHex,
        metalness: 0.1,
        roughness: 0.6,
        side: THREE.DoubleSide,
        vertexColors: colorMode === "vertex-colors" && Boolean(sharedColorAttr),
        flatShading: shadingMode === "flat",
        wireframe: currentWireframe,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = surfaceVisible;
      viewport.scene.add(mesh);
      surfaceMesh = mesh;
      surfaceGeometry = geometry;
      surfaceMaterial = material;
    }

    if (result.edgeIndices) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", sharedPositionAttr);
      if (sharedColorAttr) geometry.setAttribute("color", sharedColorAttr);
      geometry.setIndex(new THREE.BufferAttribute(result.edgeIndices, 1));

      const material = new THREE.LineBasicMaterial({
        color: currentColorHex,
        vertexColors: colorMode === "vertex-colors" && Boolean(sharedColorAttr),
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.visible = edgesVisible;
      viewport.scene.add(lines);
      edgesObj = lines;
      edgesGeometry = geometry;
      edgesMaterial = material;
    }

    {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", sharedPositionAttr);
      if (sharedColorAttr) geometry.setAttribute("color", sharedColorAttr);

      const material = new THREE.PointsMaterial({
        color: currentColorHex,
        size: pointSizePx,
        sizeAttenuation: false,
        vertexColors: colorMode === "vertex-colors" && Boolean(sharedColorAttr),
      });
      const points = new THREE.Points(geometry, material);
      points.visible = pointsVisible;
      viewport.scene.add(points);
      pointsObj = points;
      pointsGeometry = geometry;
      pointsMaterial = material;
    }

    lastFullRadius = boundsRadius(result.boundsModelUnits);
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

  // --- Model info / geometry panel ---

  function renderBounds(result: PLYViewerResult): void {
    const b = result.boundsModelUnits;
    infoWidth.textContent = `${formatMagnitude(b.size[0])} model units`;
    infoHeight.textContent = `${formatMagnitude(b.size[1])} model units`;
    infoDepth.textContent = `${formatMagnitude(b.size[2])} model units`;
  }

  function renderWarnings(warnings: PLYViewerWarning[]): void {
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

  function renderInfo(result: PLYViewerResult): void {
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoEncoding.textContent = ENCODING_LABELS[result.format];
    infoVertices.textContent = formatTriangleCount(result.sourceVertexCount);
    infoSourceFaces.textContent = formatTriangleCount(result.sourceFaceCount);
    infoTriangles.textContent = formatTriangleCount(result.renderedTriangleCount);
    infoEdges.textContent = formatTriangleCount(result.edgeCount);
    infoPoints.textContent = formatTriangleCount(result.renderedPointCount);
    infoVertexProperties.textContent = String(result.vertexPropertyCount);
    infoFaceProperties.textContent = String(result.facePropertyCount);
    infoComments.textContent = String(result.commentCount);
    infoObjInfo.textContent = String(result.objInfoCount);
    infoUnknownElements.textContent = String(result.unknownElementCount);
    infoUnknownProperties.textContent = String(result.unknownPropertyCount);
    infoSourceNormals.textContent = result.hasSourceNormals ? "Present and used" : result.renderedTriangleCount > 0 ? "Not available (computed)" : "Not applicable";
    infoVertexColors.textContent = result.hasVertexColors ? "Present" : "Not available";
    infoAlpha.textContent = result.hasAlpha ? "Present" : "Not available";
    infoTexcoords.textContent = result.hasTextureCoordinates ? "Present" : "Not available";
    infoTexcoordsNote.hidden = !result.hasTextureCoordinates;
    renderBounds(result);

    renderWarnings(result.warnings);
    modelInfo.hidden = false;
  }

  function renderGeometryPanel(result: PLYViewerResult): void {
    geometryPanel.hidden = false;
    geometryList.textContent = "";

    const rows: { category: PLYRenderCategory; label: string; count: number; visible: boolean; onToggle: (visible: boolean) => void }[] = [];
    if (result.surfaceIndices) {
      rows.push({
        category: "surface",
        label: "Surface",
        count: result.renderedTriangleCount,
        visible: surfaceVisible,
        onToggle: (visible) => {
          surfaceVisible = visible;
          if (surfaceMesh) surfaceMesh.visible = visible;
          viewport?.requestRender();
        },
      });
    }
    if (result.edgeIndices) {
      rows.push({
        category: "edges",
        label: "Explicit edges",
        count: result.edgeCount,
        visible: edgesVisible,
        onToggle: (visible) => {
          edgesVisible = visible;
          if (edgesObj) edgesObj.visible = visible;
          viewport?.requestRender();
        },
      });
    }
    rows.push({
      category: "points",
      label: "Points",
      count: result.renderedPointCount,
      visible: pointsVisible,
      onToggle: (visible) => {
        pointsVisible = visible;
        if (pointsObj) pointsObj.visible = visible;
        viewport?.requestRender();
      },
    });

    geometryNote.textContent = `${rows.length} of 3 possible render ${rows.length === 1 ? "category" : "categories"} present in this file.`;

    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "scene-tree-row";

      const checkboxId = `ply-viewer-category-${row.category}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = checkboxId;
      checkbox.checked = row.visible;
      checkbox.setAttribute("aria-label", `Show ${row.label.toLowerCase()}`);
      checkbox.addEventListener("change", () => {
        row.onToggle(checkbox.checked);
      });

      const label = document.createElement("label");
      label.className = "scene-tree-row-label";
      label.setAttribute("for", checkboxId);
      label.textContent = row.label;

      const count = document.createElement("span");
      count.className = "scene-tree-row-count";
      count.textContent = formatTriangleCount(row.count);

      rowEl.append(checkbox, label, count);
      geometryList.appendChild(rowEl);
    }
  }

  async function renderResult(result: PLYViewerResult): Promise<void> {
    try {
      await ensureViewer();
      lastResult = result;

      setupDisplayControls(result);
      buildSceneFromResult(result);
      applyColorMode();
      applyShadingMode();
      renderInfo(result);
      renderGeometryPanel(result);

      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(
        isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false },
      );
      setState("error");
    }
  }

  function createPLYViewerWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/ply-viewer.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createPLYViewerWorker, {
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
        void renderResult(result as PLYViewerResult);
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
    geometryPanel.hidden = true;
    geometryList.textContent = "";
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
    surfaceVisible = true;
    edgesVisible = true;
    pointsVisible = true;
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    resetResultsUI();

    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = { allowedExtensions: ["ply"], maxSizeBytes: MAX_SIZE_BYTES };
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
    applyWireframe();
  });

  colorModeSelect.addEventListener("change", () => {
    colorMode = colorModeSelect.value === "vertex-colors" ? "vertex-colors" : "neutral";
    applyColorMode();
  });

  shadingSelect.addEventListener("change", () => {
    shadingMode = shadingSelect.value === "flat" ? "flat" : "smooth";
    applyShadingMode();
  });

  colorSelect.addEventListener("change", () => {
    currentColorHex = colorSelect.value;
    applyColorMode();
  });

  pointSizeInput.addEventListener("input", () => {
    pointSizePx = Number(pointSizeInput.value) || 4;
    applyPointSize();
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
