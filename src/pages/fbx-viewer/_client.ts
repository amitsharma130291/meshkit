/**
 * Orchestration for /fbx-viewer/. Follows the same overall shape as
 * src/pages/glb-viewer/_client.ts (lazy Three.js viewport, camera fit
 * with OrbitControls damping cleared before repositioning, worker
 * lifecycle, index-buffer + `geometry.groups` visibility/material
 * rebuild, main-thread `createImageBitmap()` texture decode) — see that
 * file for the reasoning shared with it. What's different here: FBX
 * renders static triangle-mesh geometry only (no lines/points render
 * categories), so there's a single `Mesh` object instead of up to three;
 * and per-material Three.js materials are built directly 1:1 from
 * `result.materials` (already deduplicated in `resolve-scene.ts`) plus
 * one shared fallback appended for segments with no material at all,
 * rather than needing a second dedup pass the way GLB's raw
 * per-primitive material references required.
 *
 * Runs only when `document` exists — see the foundation-preview client
 * for why (Astro's static build imports client scripts into its server
 * module graph to resolve bundled asset URLs).
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize, formatMagnitude, formatTriangleCount } from "../../lib/stl/format";
import type { STLBounds } from "../../lib/stl/types";
import type { FBXUnsupportedFeature, FBXViewerMaterial, FBXViewerResult, FBXViewerSegment, FBXViewerWarning } from "../../lib/fbx/viewer-types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
type ColorMode = "original" | "neutral" | "vertex-colors";
type ShadingMode = "source" | "flat";

const MAX_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_RENDERED_SEGMENT_ROWS = 150;

const STAGE_LABELS: Record<string, string> = {
  "validating-header": "Validating FBX header…",
  "reading-node-records": "Reading node records…",
  "resolving-objects": "Resolving objects…",
  "resolving-connections": "Resolving connections…",
  "building-geometry": "Building geometry…",
  "preparing-scene": "Preparing scene…",
  complete: "Finishing up…",
};

const UNSUPPORTED_FEATURE_LABELS: Record<FBXUnsupportedFeature, string> = {
  animation: "animation",
  skinning: "skinning/deformers",
  skeleton: "skeleton",
  "blend-shapes": "blend shapes",
  cameras: "cameras",
  lights: "lights",
  "nurbs-or-patch-geometry": "NURBS/patch geometry",
  "subdivision-surfaces": "subdivision surfaces",
  constraints: "constraints",
  "layered-textures": "layered textures",
};

function boundsRadius(bounds: STLBounds): number {
  const [sx, sy, sz] = bounds.size;
  return Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6);
}

function unionBounds(list: STLBounds[]): STLBounds | null {
  if (list.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of list) {
    if (b.min[0] < minX) minX = b.min[0];
    if (b.min[1] < minY) minY = b.min[1];
    if (b.min[2] < minZ) minZ = b.min[2];
    if (b.max[0] > maxX) maxX = b.max[0];
    if (b.max[1] > maxY) maxY = b.max[1];
    if (b.max[2] > maxZ) maxZ = b.max[2];
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
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
  const infoVersion = document.querySelector<HTMLElement>("[data-info-version]")!;
  const infoEncoding = document.querySelector<HTMLElement>("[data-info-encoding]")!;
  const infoCreator = document.querySelector<HTMLElement>("[data-info-creator]")!;
  const infoModels = document.querySelector<HTMLElement>("[data-info-models]")!;
  const infoGeometries = document.querySelector<HTMLElement>("[data-info-geometries]")!;
  const infoMeshInstances = document.querySelector<HTMLElement>("[data-info-mesh-instances]")!;
  const infoMaterials = document.querySelector<HTMLElement>("[data-info-materials]")!;
  const infoEmbeddedTextures = document.querySelector<HTMLElement>("[data-info-embedded-textures]")!;
  const infoExternalTextures = document.querySelector<HTMLElement>("[data-info-external-textures]")!;
  const infoControlPoints = document.querySelector<HTMLElement>("[data-info-control-points]")!;
  const infoPolygons = document.querySelector<HTMLElement>("[data-info-polygons]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoSkippedPolygons = document.querySelector<HTMLElement>("[data-info-skipped-polygons]")!;
  const infoSourceNormals = document.querySelector<HTMLElement>("[data-info-source-normals]")!;
  const infoUVs = document.querySelector<HTMLElement>("[data-info-uvs]")!;
  const infoVertexColors = document.querySelector<HTMLElement>("[data-info-vertex-colors]")!;
  const infoUnitScale = document.querySelector<HTMLElement>("[data-info-unit-scale]")!;
  const infoAxisSystem = document.querySelector<HTMLElement>("[data-info-axis-system]")!;
  const infoWidth = document.querySelector<HTMLElement>("[data-info-width]")!;
  const infoHeight = document.querySelector<HTMLElement>("[data-info-height]")!;
  const infoDepth = document.querySelector<HTMLElement>("[data-info-depth]")!;
  const infoUnitNote = document.querySelector<HTMLElement>("[data-info-unit-note]")!;
  const infoUnsupportedFeatures = document.querySelector<HTMLElement>("[data-info-unsupported-features]")!;
  const infoWarnings = document.querySelector<HTMLElement>("[data-info-warnings]")!;

  const sceneTree = document.querySelector<HTMLElement>("[data-scene-tree]")!;
  const sceneTreeNote = document.querySelector<HTMLElement>("[data-scene-tree-note]")!;
  const sceneTreeList = document.querySelector<HTMLElement>("[data-scene-tree-list]")!;
  const showAllButton = document.querySelector<HTMLButtonElement>('[data-action="show-all-segments"]')!;
  const hideAllButton = document.querySelector<HTMLButtonElement>('[data-action="hide-all-segments"]')!;

  const materialPanel = document.querySelector<HTMLElement>("[data-material-panel]")!;
  const materialList = document.querySelector<HTMLElement>("[data-material-list]")!;
  const materialEmpty = document.querySelector<HTMLElement>("[data-material-empty]")!;

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitAllButton = document.querySelector<HTMLButtonElement>('[data-action="fit-all"]')!;
  const fitVisibleButton = document.querySelector<HTMLButtonElement>('[data-action="fit-visible"]')!;
  const wireframeButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-wireframe"]')!;
  const colorModeSelect = document.querySelector<HTMLSelectElement>('[data-action="color-mode"]')!;
  const colorModeNote = document.querySelector<HTMLElement>("[data-color-mode-note]")!;
  const shadingSelect = document.querySelector<HTMLSelectElement>('[data-action="shading-mode"]')!;
  const shadingNote = document.querySelector<HTMLElement>("[data-shading-note]")!;
  const colorSelect = document.querySelector<HTMLSelectElement>('[data-action="model-color"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastResult: FBXViewerResult | null = null;
  let lastFullRadius: number | null = null;
  let hiddenSegmentIndices = new Set<number>();
  let colorMode: ColorMode = "original";
  let shadingMode: ShadingMode = "source";
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;

  let triangleMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let triangleGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let originalMaterials: InstanceType<ThreeModule["Material"]>[] = [];
  let neutralMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let vertexColorMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let allBuiltMaterials: InstanceType<ThreeModule["Material"]>[] = [];

  let decodedTextures: (InstanceType<ThreeModule["Texture"]> | null)[] = [];
  let decodedBitmaps: (ImageBitmap | null)[] = [];

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

  function disposeTextures(): void {
    for (const tex of decodedTextures) tex?.dispose();
    decodedTextures = [];
    for (const bitmap of decodedBitmaps) bitmap?.close();
    decodedBitmaps = [];
  }

  function disposeMaterials(): void {
    for (const m of originalMaterials) m.dispose();
    originalMaterials = [];
    neutralMaterial?.dispose();
    neutralMaterial = null;
    vertexColorMaterial?.dispose();
    vertexColorMaterial = null;
    allBuiltMaterials = [];
  }

  function disposeCurrentModel(): void {
    if (triangleMesh && viewport) viewport.scene.remove(triangleMesh);
    triangleGeometry?.dispose();
    triangleGeometry = null;
    triangleMesh = null;
    disposeMaterials();
    disposeTextures();

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
    lastResult.segments.forEach((segment, index) => {
      if (hiddenSegmentIndices.has(index)) return;
      boundsList.push(segment.bounds);
    });
    const combined = unionBounds(boundsList);
    if (!combined) return;
    fitCameraAndControls(boundsRadius(combined), combined.center);
  }

  // --- Visibility + material-group rebuild (rebuilt together, never independently) ---

  function rebuildTriangleGeometry(): void {
    if (!triangleGeometry || !lastResult || !THREE) return;
    const segments = lastResult.segments;
    const fullIndices = lastResult.indices;
    const fallbackMaterialIndex = originalMaterials.length - 1;

    let total = 0;
    segments.forEach((segment, i) => {
      if (!hiddenSegmentIndices.has(i)) total += segment.indexCount;
    });

    const newIndex = new Uint32Array(total);
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    let offset = 0;
    segments.forEach((segment, i) => {
      if (hiddenSegmentIndices.has(i)) return;
      for (let k = 0; k < segment.indexCount; k++) newIndex[offset + k] = fullIndices[segment.indexStart + k];
      const materialArrayIndex = segment.materialIndex !== null ? segment.materialIndex : fallbackMaterialIndex;
      groups.push({ start: offset, count: segment.indexCount, materialIndex: materialArrayIndex });
      offset += segment.indexCount;
    });

    triangleGeometry.setIndex(new THREE.BufferAttribute(newIndex, 1));
    triangleGeometry.clearGroups();
    for (const g of groups) triangleGeometry.addGroup(g.start, g.count, g.materialIndex);
    viewport?.requestRender();
  }

  // --- Textures and materials ---

  async function decodeImages(result: FBXViewerResult): Promise<void> {
    decodedBitmaps = [];
    for (const image of result.images) {
      if (!image) {
        decodedBitmaps.push(null);
        continue;
      }
      if (typeof createImageBitmap !== "function") {
        decodedBitmaps.push(null);
        continue;
      }
      try {
        const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
        const bitmap = await createImageBitmap(blob);
        decodedBitmaps.push(bitmap);
      } catch {
        decodedBitmaps.push(null);
      }
    }
  }

  function buildTextureFor(imageIndex: number): InstanceType<ThreeModule["Texture"]> | null {
    if (!THREE) return null;
    const bitmap = decodedBitmaps[imageIndex];
    if (!bitmap) return null;
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    decodedTextures.push(texture);
    return texture;
  }

  function buildMaterialFromDescriptor(desc: FBXViewerMaterial): InstanceType<ThreeModule["Material"]> {
    if (!THREE) throw new Error("THREE not loaded");
    const map = desc.embeddedImageIndex !== null ? buildTextureFor(desc.embeddedImageIndex) : null;
    const [r, g, b] = desc.diffuseColor;
    const f = desc.diffuseFactor;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(r * f, g * f, b * f),
      map,
      transparent: desc.opacity < 1,
      opacity: desc.opacity,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.7,
      wireframe: currentWireframe,
      flatShading: shadingMode === "flat",
    });
  }

  function buildOriginalMaterials(result: FBXViewerResult): void {
    if (!THREE) return;
    originalMaterials = result.materials.map((m) => buildMaterialFromDescriptor(m));
    // One shared fallback material appended at the end for any segment with no connected material at all.
    originalMaterials.push(
      new THREE.MeshStandardMaterial({ color: currentColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" }),
    );
  }

  function applyColorMode(): void {
    if (!triangleMesh || !triangleGeometry || !THREE || !lastResult) return;

    if (colorMode === "original") {
      triangleMesh.material = originalMaterials;
    } else if (colorMode === "neutral") {
      if (!neutralMaterial) {
        neutralMaterial = new THREE.MeshStandardMaterial({ color: currentColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" });
        allBuiltMaterials.push(neutralMaterial);
      } else {
        neutralMaterial.color.set(currentColorHex);
      }
      triangleMesh.material = neutralMaterial;
    } else if (colorMode === "vertex-colors" && lastResult.hasVertexColors) {
      if (!vertexColorMaterial) {
        vertexColorMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" });
        allBuiltMaterials.push(vertexColorMaterial);
      }
      triangleMesh.material = vertexColorMaterial;
    }
    viewport?.requestRender();
  }

  function applyShadingMode(): void {
    const flat = shadingMode === "flat";
    for (const m of [...originalMaterials, ...allBuiltMaterials]) {
      if ("flatShading" in m) {
        (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).flatShading = flat;
        m.needsUpdate = true;
      }
    }
    viewport?.requestRender();
  }

  function setupDisplayControls(result: FBXViewerResult): void {
    shadingMode = result.hasSourceNormals ? "source" : "flat";
    shadingSelect.value = shadingMode;
    shadingSelect.disabled = !result.hasSourceNormals;
    shadingNote.hidden = result.hasSourceNormals;
    if (!result.hasSourceNormals) shadingNote.textContent = "This file has no usable source normals, so source shading isn't available.";

    const vertexColorOption = colorModeSelect.querySelector<HTMLOptionElement>('option[value="vertex-colors"]');
    if (vertexColorOption) vertexColorOption.disabled = !result.hasVertexColors;
    colorMode = "original";
    colorModeSelect.value = colorMode;
    colorModeNote.hidden = true;
  }

  function buildSceneFromResult(result: FBXViewerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    if (result.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(result.uvs, 2));
    if (result.colors) geometry.setAttribute("color", new THREE.BufferAttribute(result.colors, 4));

    buildOriginalMaterials(result);
    const mesh = new THREE.Mesh(geometry, originalMaterials);
    viewport.scene.add(mesh);
    triangleMesh = mesh;
    triangleGeometry = geometry;

    hiddenSegmentIndices.clear();
    rebuildTriangleGeometry();
    applyColorMode();
    applyShadingMode();

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

  // --- Model info / scene tree / materials panel ---

  function renderBounds(result: FBXViewerResult): void {
    const b = result.boundsModelUnits;
    const unit = result.normalizedToMeters ? "m" : "model units";
    infoWidth.textContent = `${formatMagnitude(b.size[0])} ${unit}`;
    infoHeight.textContent = `${formatMagnitude(b.size[1])} ${unit}`;
    infoDepth.textContent = `${formatMagnitude(b.size[2])} ${unit}`;
  }

  function renderWarnings(warnings: FBXViewerWarning[]): void {
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
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning.message;
      list.appendChild(item);
    }
    infoWarnings.appendChild(list);
  }

  function renderInfo(result: FBXViewerResult): void {
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoVersion.textContent = String(result.fbxVersion);
    infoEncoding.textContent = `Binary (${result.recordLayout} records)`;
    infoCreator.textContent = result.creator ?? "Not declared";
    infoModels.textContent = formatTriangleCount(result.modelCount);
    infoGeometries.textContent = formatTriangleCount(result.geometryCount);
    infoMeshInstances.textContent = formatTriangleCount(result.meshInstanceCount);
    infoMaterials.textContent = formatTriangleCount(result.materialCount);
    infoEmbeddedTextures.textContent = formatTriangleCount(result.embeddedTextureCount);
    infoExternalTextures.textContent = formatTriangleCount(result.externalTextureReferenceCount);
    infoControlPoints.textContent = formatTriangleCount(result.controlPointCount);
    infoPolygons.textContent = formatTriangleCount(result.polygonCount);
    infoTriangles.textContent = formatTriangleCount(result.renderedTriangleCount);
    infoSkippedPolygons.textContent = formatTriangleCount(result.skippedPolygonCount);
    infoSourceNormals.textContent = result.hasSourceNormals ? "Present and used" : "Not available (computed)";
    infoUVs.textContent = result.hasUVs ? "Present" : "Not available";
    infoVertexColors.textContent = result.hasVertexColors ? "Present" : "Not available";
    infoUnitScale.textContent = result.sourceUnitScaleFactor !== null ? `${formatMagnitude(result.sourceUnitScaleFactor)} cm per unit` : "Not declared";
    infoAxisSystem.textContent = result.axisSystemKnown ? "Declared — normalized to right-handed, Y-up" : "Not declared or inconsistent";
    renderBounds(result);

    infoUnitNote.textContent = result.normalizedToMeters
      ? "This file's own unit scale and axis system were declared and consistent, so dimensions above are shown normalized to meters in a right-handed, Y-up system."
      : "This file's unit scale or axis system wasn't fully and consistently declared, so dimensions above are shown unconverted, in the file's own model units.";

    if (result.unsupportedFeatures.length > 0) {
      infoUnsupportedFeatures.hidden = false;
      infoUnsupportedFeatures.textContent = `Detected but not applied: ${result.unsupportedFeatures.map((f) => UNSUPPORTED_FEATURE_LABELS[f]).join(", ")}.`;
    } else {
      infoUnsupportedFeatures.hidden = true;
    }

    renderWarnings(result.warnings);
    modelInfo.hidden = false;
  }

  function renderMaterials(result: FBXViewerResult): void {
    materialPanel.hidden = false;
    materialList.textContent = "";
    if (result.materials.length === 0) {
      materialEmpty.hidden = false;
      return;
    }
    materialEmpty.hidden = true;
    result.materials.forEach((material) => {
      const card = document.createElement("div");
      card.className = "glb-material-card";

      const swatch = document.createElement("span");
      swatch.className = "glb-material-swatch";
      const [r, g, b] = material.diffuseColor;
      swatch.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

      const details = document.createElement("div");
      details.className = "glb-material-details";
      const name = document.createElement("p");
      name.className = "glb-material-name";
      name.textContent = material.name || "(unnamed material)";
      const meta = document.createElement("p");
      meta.className = "glb-material-meta";
      const parts = [
        material.shadingModel,
        `Diffuse factor ${material.diffuseFactor.toFixed(2)}`,
        material.opacity < 1 ? `Opacity ${material.opacity.toFixed(2)}` : null,
        material.embeddedImageIndex !== null ? "embedded texture" : null,
        material.hasExternalOrUnsupportedTexture ? "external/unsupported texture" : null,
      ].filter((p): p is string => p !== null);
      meta.textContent = parts.join(" · ");

      details.append(name, meta);
      card.append(swatch, details);
      materialList.appendChild(card);
    });
  }

  function renderSceneTree(result: FBXViewerResult): void {
    sceneTree.hidden = false;
    sceneTreeList.textContent = "";

    const segments = result.segments;
    const rendered = segments.slice(0, MAX_RENDERED_SEGMENT_ROWS);
    const overflow = segments.length - rendered.length;

    sceneTreeNote.textContent =
      overflow > 0
        ? `Showing ${rendered.length} of ${segments.length} mesh instances individually. "Show all" and "Hide all" apply to every one.`
        : `${segments.length} rendered mesh ${segments.length === 1 ? "instance" : "instances"}.`;

    const groupOrder: string[] = [];
    const byModel = new Map<string, { segment: FBXViewerSegment; index: number }[]>();
    rendered.forEach((segment, index) => {
      const key = segment.modelName ?? `Model ${index}`;
      if (!byModel.has(key)) {
        byModel.set(key, []);
        groupOrder.push(key);
      }
      byModel.get(key)!.push({ segment, index });
    });

    for (const key of groupOrder) {
      const wrap = document.createElement("div");
      wrap.className = "scene-tree-object-group";
      const rows = byModel.get(key)!;
      const heading = document.createElement("p");
      heading.className = "scene-tree-object-name";
      heading.textContent = key;
      wrap.appendChild(heading);

      for (const { segment, index } of rows) {
        const row = document.createElement("div");
        row.className = "scene-tree-row";

        const checkboxId = `fbx-viewer-segment-${index}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = checkboxId;
        checkbox.checked = !hiddenSegmentIndices.has(index);
        checkbox.setAttribute("aria-label", `Show ${key}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenSegmentIndices.delete(index);
          else hiddenSegmentIndices.add(index);
          rebuildTriangleGeometry();
        });

        const label = document.createElement("label");
        label.className = "scene-tree-row-label";
        label.setAttribute("for", checkboxId);
        const materialName = segment.materialIndex !== null ? result.materials[segment.materialIndex]?.name : null;
        label.textContent = `Mesh instance${materialName ? ` · ${materialName}` : ""}`;

        const count = document.createElement("span");
        count.className = "scene-tree-row-count";
        count.textContent = formatTriangleCount(segment.indexCount / 3);

        const isolateButton = document.createElement("button");
        isolateButton.type = "button";
        isolateButton.className = "scene-tree-isolate";
        isolateButton.textContent = "Isolate";
        isolateButton.addEventListener("click", () => {
          hiddenSegmentIndices = new Set(segments.map((_, segmentIndex) => segmentIndex).filter((segmentIndex) => segmentIndex !== index));
          rebuildTriangleGeometry();
          renderSceneTree(result);
        });

        row.append(checkbox, label, count, isolateButton);
        wrap.appendChild(row);
      }

      sceneTreeList.appendChild(wrap);
    }
  }

  async function renderResult(result: FBXViewerResult): Promise<void> {
    try {
      await ensureViewer();
      lastResult = result;

      await decodeImages(result);
      setupDisplayControls(result);
      buildSceneFromResult(result);
      renderInfo(result);
      renderMaterials(result);
      renderSceneTree(result);

      successConfirmation.hidden = false;
      setState("success");
    } catch (error) {
      showError(isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false });
      setState("error");
    }
  }

  function createFBXViewerWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/fbx-viewer.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createFBXViewerWorker, {
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
        void renderResult(result as FBXViewerResult);
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
    materialPanel.hidden = true;
    materialList.textContent = "";
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

    const config: FileValidationConfig = { allowedExtensions: ["fbx"], maxSizeBytes: MAX_SIZE_BYTES };
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
    for (const m of [...originalMaterials, ...allBuiltMaterials]) {
      (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).wireframe = currentWireframe;
    }
    viewport?.requestRender();
  });

  colorModeSelect.addEventListener("change", () => {
    const value = colorModeSelect.value;
    colorMode = value === "neutral" || value === "vertex-colors" ? value : "original";
    applyColorMode();
  });

  shadingSelect.addEventListener("change", () => {
    shadingMode = shadingSelect.value === "flat" ? "flat" : "source";
    applyShadingMode();
  });

  colorSelect.addEventListener("change", () => {
    currentColorHex = colorSelect.value;
    if (colorMode === "neutral" && neutralMaterial) {
      neutralMaterial.color.set(currentColorHex);
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
    rebuildTriangleGeometry();
    if (lastResult) renderSceneTree(lastResult);
  });
  hideAllButton.addEventListener("click", () => {
    if (!lastResult) return;
    hiddenSegmentIndices = new Set(lastResult.segments.map((_, index) => index));
    rebuildTriangleGeometry();
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
