/**
 * Orchestration for /obj-viewer/. Follows the same shape as
 * src/pages/stl-viewer/_client.ts (lazy Three.js viewport, camera fit with
 * OrbitControls damping cleared before repositioning, worker lifecycle) —
 * see that file and docs/ARCHITECTURE.md for the reasoning behind each
 * piece shared with it. What's new here, unique to a multi-object OBJ
 * scene: per-segment visibility (an `Uint32Array` index rebuilt from the
 * static position/normal attributes — never a duplicated geometry per
 * toggle), a "fit visible" camera mode that unions only the visible
 * segments'/lines'/points' precomputed bounds, a source/flat shading
 * toggle that swaps which precomputed normal attribute is bound, and
 * optional line/point primitives rendered as separate small scene objects.
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
import type { OBJViewerResult, OBJViewerSegment, OBJViewerWarning } from "../../lib/obj/viewer-types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
type ShadingMode = "smooth" | "flat";

const MAX_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_RENDERED_SEGMENT_ROWS = 150;
const LINE_COLOR = "#24b8d8";
const POINT_COLOR = "#ed4b93";

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading file…",
  decoding: "Decoding text…",
  "parsing-faces": "Parsing geometry…",
  "building-segments": "Organizing objects and groups…",
  "building-viewer-geometry": "Preparing model…",
  complete: "Finishing up…",
};

function computeBoundsFromFlatArray(values: Float32Array): STLBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i];
    const y = values[i + 1];
    const z = values[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
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
  const infoVertices = document.querySelector<HTMLElement>("[data-info-vertices]")!;
  const infoNormals = document.querySelector<HTMLElement>("[data-info-normals]")!;
  const infoTexcoords = document.querySelector<HTMLElement>("[data-info-texcoords]")!;
  const infoSourceFaces = document.querySelector<HTMLElement>("[data-info-source-faces]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoObjects = document.querySelector<HTMLElement>("[data-info-objects]")!;
  const infoGroups = document.querySelector<HTMLElement>("[data-info-groups]")!;
  const infoMtllibs = document.querySelector<HTMLElement>("[data-info-mtllibs]")!;
  const infoMaterials = document.querySelector<HTMLElement>("[data-info-materials]")!;
  const infoLines = document.querySelector<HTMLElement>("[data-info-lines]")!;
  const infoPoints = document.querySelector<HTMLElement>("[data-info-points]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const infoBboxMin = document.querySelector<HTMLElement>("[data-info-bbox-min]")!;
  const infoBboxMax = document.querySelector<HTMLElement>("[data-info-bbox-max]")!;
  const infoSourceNormals = document.querySelector<HTMLElement>("[data-info-source-normals]")!;
  const infoMaterialsNote = document.querySelector<HTMLElement>("[data-info-materials-note]")!;
  const infoWarnings = document.querySelector<HTMLElement>("[data-info-warnings]")!;

  const sceneTree = document.querySelector<HTMLElement>("[data-scene-tree]")!;
  const sceneTreeNote = document.querySelector<HTMLElement>("[data-scene-tree-note]")!;
  const sceneTreeList = document.querySelector<HTMLElement>("[data-scene-tree-list]")!;
  const showAllButton = document.querySelector<HTMLButtonElement>('[data-action="show-all-segments"]')!;
  const hideAllButton = document.querySelector<HTMLButtonElement>('[data-action="hide-all-segments"]')!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitVisibleButton = document.querySelector<HTMLButtonElement>('[data-action="fit-visible"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const shadingSelect = document.querySelector<HTMLSelectElement>('[data-action="shading-mode"]')!;
  const shadingNote = document.querySelector<HTMLElement>("[data-shading-note]")!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const linesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-lines"]')!;
  const pointsButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-points"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastResult: OBJViewerResult | null = null;
  let lastFullRadius: number | null = null;
  let linesBoundsCache: STLBounds | null = null;
  let pointsBoundsCache: STLBounds | null = null;
  let hiddenSegmentIndices = new Set<number>();
  let shadingMode: ShadingMode = "flat";
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";
  let linesVisible = true;
  let pointsVisible = true;
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let currentMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let currentGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let currentLineSegments: InstanceType<ThreeModule["LineSegments"]> | null = null;
  let currentLineGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentLineMaterial: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;
  let currentPoints: InstanceType<ThreeModule["Points"]> | null = null;
  let currentPointGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let currentPointMaterial: InstanceType<ThreeModule["PointsMaterial"]> | null = null;
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

    if (currentLineSegments && viewport) viewport.scene.remove(currentLineSegments);
    currentLineGeometry?.dispose();
    currentLineMaterial?.dispose();
    currentLineSegments = null;
    currentLineGeometry = null;
    currentLineMaterial = null;

    if (currentPoints && viewport) viewport.scene.remove(currentPoints);
    currentPointGeometry?.dispose();
    currentPointMaterial?.dispose();
    currentPoints = null;
    currentPointGeometry = null;
    currentPointMaterial = null;

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
    if (linesVisible && linesBoundsCache) boundsList.push(linesBoundsCache);
    if (pointsVisible && pointsBoundsCache) boundsList.push(pointsBoundsCache);

    const combined = unionBounds(boundsList);
    if (!combined) return;

    const fullCenter = lastResult.bounds.center;
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

  function buildSceneFromResult(result: OBJViewerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    const activeNormals = shadingMode === "smooth" && result.hasValidSourceNormals ? result.normals : result.flatNormals;
    geometry.setAttribute("normal", new THREE.BufferAttribute(activeNormals, 3));

    const material = new THREE.MeshStandardMaterial({
      color: currentColorHex,
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      wireframe: currentWireframe,
    });

    const mesh = new THREE.Mesh(geometry, material);
    const fullCenter = result.bounds.center;
    mesh.position.set(-fullCenter[0], -fullCenter[1], -fullCenter[2]);
    viewport.scene.add(mesh);

    currentMesh = mesh;
    currentGeometry = geometry;
    currentMaterial = material;

    if (result.lineGeometry && result.lineGeometry.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(result.lineGeometry, 3));
      const lineMaterial = new THREE.LineBasicMaterial({ color: LINE_COLOR });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      lines.position.copy(mesh.position);
      lines.visible = linesVisible;
      viewport.scene.add(lines);
      currentLineSegments = lines;
      currentLineGeometry = lineGeometry;
      currentLineMaterial = lineMaterial;
    }

    if (result.pointGeometry && result.pointGeometry.length > 0) {
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute("position", new THREE.BufferAttribute(result.pointGeometry, 3));
      const pointMaterial = new THREE.PointsMaterial({ color: POINT_COLOR, size: 4, sizeAttenuation: false });
      const points = new THREE.Points(pointGeometry, pointMaterial);
      points.position.copy(mesh.position);
      points.visible = pointsVisible;
      viewport.scene.add(points);
      currentPoints = points;
      currentPointGeometry = pointGeometry;
      currentPointMaterial = pointMaterial;
    }

    hiddenSegmentIndices.clear();
    rebuildVisibleIndex();

    lastFullRadius = boundsRadius(result.bounds);
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

  function renderBounds(bounds: STLBounds): void {
    infoWidth.textContent = `${formatMagnitude(bounds.size[0])} model units`;
    infoHeight.textContent = `${formatMagnitude(bounds.size[1])} model units`;
    infoDepth.textContent = `${formatMagnitude(bounds.size[2])} model units`;
    infoBboxMin.textContent = `(${bounds.min.map(formatMagnitude).join(", ")}) model units`;
    infoBboxMax.textContent = `(${bounds.max.map(formatMagnitude).join(", ")}) model units`;
  }

  function renderWarnings(warnings: OBJViewerWarning[]): void {
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

  function renderInfo(result: OBJViewerResult): void {
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoVertices.textContent = formatTriangleCount(result.sourceVertexCount);
    infoNormals.textContent = formatTriangleCount(result.sourceNormalCount);
    infoTexcoords.textContent = formatTriangleCount(result.sourceTextureCoordinateCount);
    infoSourceFaces.textContent = formatTriangleCount(result.sourceFaceCount);
    infoTriangles.textContent = formatTriangleCount(result.triangleCount);
    infoObjects.textContent = String(result.objectCount);
    infoGroups.textContent = String(result.groupCount);
    infoMtllibs.textContent = String(result.materialLibraryCount);
    infoMaterials.textContent =
      result.usedMaterialCount > 0
        ? `${result.usedMaterialCount} (${result.usedMaterialNames.slice(0, 8).join(", ")}${result.usedMaterialCount > 8 ? ", …" : ""})`
        : "None";
    infoLines.textContent = formatTriangleCount(result.lineCount);
    infoPoints.textContent = formatTriangleCount(result.pointCount);
    renderBounds(result.bounds);
    infoSourceNormals.textContent = result.hasValidSourceNormals ? "Present and used" : "Not available";

    if (result.materialLibraryCount > 0 || result.usedMaterialCount > 0 || result.hasTextureCoordinates) {
      infoMaterialsNote.hidden = false;
      infoMaterialsNote.textContent =
        "Referenced materials and textures are shown for information only — MeshWrench never fetches them, so the preview uses a neutral material.";
    } else {
      infoMaterialsNote.hidden = true;
    }

    renderWarnings(result.warnings);
    modelInfo.hidden = false;
  }

  function renderSceneTree(result: OBJViewerResult): void {
    sceneTree.hidden = false;
    sceneTreeList.textContent = "";

    const segments = result.segments;
    const rendered = segments.slice(0, MAX_RENDERED_SEGMENT_ROWS);
    const overflow = segments.length - rendered.length;

    sceneTreeNote.textContent =
      overflow > 0
        ? `Showing ${rendered.length} of ${segments.length} objects/groups individually. "Show all" and "Hide all" apply to every one.`
        : `${segments.length} object/group ${segments.length === 1 ? "entry" : "entries"}.`;

    const objectOrder: string[] = [];
    const byObject = new Map<string, { segment: OBJViewerSegment; index: number }[]>();
    rendered.forEach((segment, index) => {
      if (!byObject.has(segment.objectName)) {
        byObject.set(segment.objectName, []);
        objectOrder.push(segment.objectName);
      }
      byObject.get(segment.objectName)!.push({ segment, index });
    });

    for (const objectName of objectOrder) {
      const wrap = document.createElement("div");
      wrap.className = "scene-tree-object-group";
      const heading = document.createElement("p");
      heading.className = "scene-tree-object-name";
      heading.textContent = objectName;
      wrap.appendChild(heading);

      for (const { segment, index } of byObject.get(objectName)!) {
        const row = document.createElement("div");
        row.className = "scene-tree-row";

        const checkboxId = `obj-viewer-segment-${index}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = checkboxId;
        checkbox.checked = !hiddenSegmentIndices.has(index);
        checkbox.setAttribute("aria-label", `Show ${segment.groupNames.join(", ")}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenSegmentIndices.delete(index);
          else hiddenSegmentIndices.add(index);
          rebuildVisibleIndex();
        });

        const label = document.createElement("label");
        label.className = "scene-tree-row-label";
        label.setAttribute("for", checkboxId);
        const materialText = segment.materialName ? ` · ${segment.materialName}` : "";
        label.textContent = `${segment.groupNames.join(", ")}${materialText}`;

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

  function setupShadingControl(result: OBJViewerResult): void {
    shadingMode = result.hasValidSourceNormals ? "smooth" : "flat";
    shadingSelect.value = shadingMode;
    shadingSelect.disabled = !result.hasValidSourceNormals;
    if (!result.hasValidSourceNormals) {
      shadingNote.hidden = false;
      shadingNote.textContent = "This file has no usable vertex normals, so source/smooth shading isn't available.";
    } else {
      shadingNote.hidden = true;
      shadingNote.textContent = "";
    }
  }

  function setupLinePointControls(result: OBJViewerResult): void {
    linesVisible = true;
    pointsVisible = true;
    linesButton.hidden = result.lineCount === 0;
    pointsButton.hidden = result.pointCount === 0;
    linesButton.setAttribute("aria-pressed", "true");
    linesButton.textContent = "Hide lines";
    pointsButton.setAttribute("aria-pressed", "true");
    pointsButton.textContent = "Hide points";
  }

  async function renderResult(result: OBJViewerResult): Promise<void> {
    try {
      await ensureViewer();
      lastResult = result;
      linesBoundsCache = result.lineGeometry ? computeBoundsFromFlatArray(result.lineGeometry) : null;
      pointsBoundsCache = result.pointGeometry ? computeBoundsFromFlatArray(result.pointGeometry) : null;

      setupShadingControl(result);
      setupLinePointControls(result);
      buildSceneFromResult(result);
      renderInfo(result);
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

  function createOBJViewerWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/obj-viewer.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createOBJViewerWorker, {
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
        void renderResult(result as OBJViewerResult);
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
    linesBoundsCache = null;
    pointsBoundsCache = null;
    hiddenSegmentIndices = new Set();
    linesVisible = true;
    pointsVisible = true;
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    resetResultsUI();

    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = { allowedExtensions: ["obj"], maxSizeBytes: MAX_SIZE_BYTES };
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

  shadingSelect.addEventListener("change", () => {
    shadingMode = shadingSelect.value === "smooth" ? "smooth" : "flat";
    if (currentGeometry && lastResult && THREE) {
      const active = shadingMode === "smooth" && lastResult.hasValidSourceNormals ? lastResult.normals : lastResult.flatNormals;
      currentGeometry.setAttribute("normal", new THREE.BufferAttribute(active, 3));
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

  linesButton.addEventListener("click", () => {
    linesVisible = !linesVisible;
    linesButton.setAttribute("aria-pressed", String(linesVisible));
    linesButton.textContent = linesVisible ? "Hide lines" : "Show lines";
    if (currentLineSegments) {
      currentLineSegments.visible = linesVisible;
      viewport?.requestRender();
    }
  });
  pointsButton.addEventListener("click", () => {
    pointsVisible = !pointsVisible;
    pointsButton.setAttribute("aria-pressed", String(pointsVisible));
    pointsButton.textContent = pointsVisible ? "Hide points" : "Show points";
    if (currentPoints) {
      currentPoints.visible = pointsVisible;
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
