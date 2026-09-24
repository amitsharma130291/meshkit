/**
 * Orchestration for /glb-viewer/. Follows the same shape as
 * src/pages/3mf-viewer/_client.ts (lazy Three.js viewport, camera fit with
 * OrbitControls damping cleared before repositioning, worker lifecycle,
 * fit-visible via precomputed per-segment bounds) — see that file for the
 * reasoning shared with it. What's new here: real per-primitive PBR
 * materials rendered via Three.js's `geometry.groups` + a material array
 * (rebuilt together with the visibility index whenever segments toggle,
 * so the two never drift out of sync), main-thread image decoding via
 * `createImageBitmap` (the worker only ever extracts and validates
 * still-encoded image bytes — see docs/ARCHITECTURE.md for why decoding
 * never happens off-main-thread here), and four display modes instead of
 * a single neutral/embedded toggle.
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
import { buildSegmentStructuralLabel } from "../../lib/glb/viewer-formatting";
import type { GLBViewerMaterial, GLBViewerResult, GLBViewerSegment, GLBViewerTexture, GLBViewerWarning } from "../../lib/glb/viewer-types";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import { disposeObject3D } from "../../lib/three/disposal";
import type { MagnificationTextureFilter, MinificationTextureFilter, Wrapping } from "three";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
type ColorMode = "original" | "neutral" | "vertex-colors" | "node";
type ShadingMode = "source" | "flat";

const MAX_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_RENDERED_SEGMENT_ROWS = 150;
const NODE_COLOR_PALETTE = ["#6d42f5", "#24b8d8", "#ed4b93", "#f5a623", "#2ecc71", "#e74c3c", "#9b59b6", "#1abc9c", "#f39c12", "#34495e"];

const STAGE_LABELS: Record<string, string> = {
  "reading-container": "Reading file…",
  "validating-header": "Validating header…",
  "parsing-json": "Parsing scene description…",
  "validating-resources": "Reading materials and textures…",
  "reading-accessors": "Reading geometry…",
  "resolving-scene": "Resolving scene…",
  "building-primitives": "Building primitives…",
  "extracting-materials": "Extracting materials…",
  "extracting-images": "Extracting images…",
  "building-hierarchy": "Building hierarchy…",
  complete: "Finishing up…",
};

// glTF sampler/wrap enum values (glTF spec §Sampler).
const WRAP_CLAMP = 33071;
const WRAP_MIRROR = 33648;
const FILTER_NEAREST = 9728;
const FILTER_NEAREST_MIPMAP_NEAREST = 9984;
const FILTER_LINEAR_MIPMAP_NEAREST = 9985;
const FILTER_NEAREST_MIPMAP_LINEAR = 9986;

function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = (h * 33 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function hexToRGB01(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
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
  const infoVersion = document.querySelector<HTMLElement>("[data-info-version]")!;
  const infoSceneName = document.querySelector<HTMLElement>("[data-info-scene-name]")!;
  const infoSceneCount = document.querySelector<HTMLElement>("[data-info-scene-count]")!;
  const infoNodeCount = document.querySelector<HTMLElement>("[data-info-node-count]")!;
  const infoMeshCount = document.querySelector<HTMLElement>("[data-info-mesh-count]")!;
  const infoPrimitiveCount = document.querySelector<HTMLElement>("[data-info-primitive-count]")!;
  const infoNodeInstances = document.querySelector<HTMLElement>("[data-info-node-instances]")!;
  const infoSourceVertices = document.querySelector<HTMLElement>("[data-info-source-vertices]")!;
  const infoTriangles = document.querySelector<HTMLElement>("[data-info-triangles]")!;
  const infoLines = document.querySelector<HTMLElement>("[data-info-lines]")!;
  const infoPoints = document.querySelector<HTMLElement>("[data-info-points]")!;
  const infoMaterials = document.querySelector<HTMLElement>("[data-info-materials]")!;
  const infoTextures = document.querySelector<HTMLElement>("[data-info-textures]")!;
  const infoImages = document.querySelector<HTMLElement>("[data-info-images]")!;
  const infoAnimations = document.querySelector<HTMLElement>("[data-info-animations]")!;
  const infoSkins = document.querySelector<HTMLElement>("[data-info-skins]")!;
  const infoMorphTargets = document.querySelector<HTMLElement>("[data-info-morph-targets]")!;
  const infoSourceNormals = document.querySelector<HTMLElement>("[data-info-source-normals]")!;
  const infoTangents = document.querySelector<HTMLElement>("[data-info-tangents]")!;
  const infoVertexColors = document.querySelector<HTMLElement>("[data-info-vertex-colors]")!;
  const infoWidthM = document.querySelector<HTMLElement>("[data-info-width-m]")!;
  const infoHeightM = document.querySelector<HTMLElement>("[data-info-height-m]")!;
  const infoDepthM = document.querySelector<HTMLElement>("[data-info-depth-m]")!;
  const infoWidthMm = document.querySelector<HTMLElement>("[data-info-width-mm]")!;
  const infoHeightMm = document.querySelector<HTMLElement>("[data-info-height-mm]")!;
  const infoDepthMm = document.querySelector<HTMLElement>("[data-info-depth-mm]")!;
  const infoExtensions = document.querySelector<HTMLElement>("[data-info-extensions]")!;
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
  const surfacesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-surfaces"]')!;
  const linesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-lines"]')!;
  const pointsButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-points"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastFileSize = 0;
  let lastResult: GLBViewerResult | null = null;
  let lastFullRadius: number | null = null;
  let hiddenSegmentIndices = new Set<number>();
  let colorMode: ColorMode = "original";
  let shadingMode: ShadingMode = "source";
  let nodeColorArrayCache: Float32Array | null = null;
  let currentWireframe = false;
  let currentColorHex = colorSelect.value || "#c7c2de";
  let surfacesVisible = true;
  let linesVisible = true;
  let pointsVisible = true;
  let gridVisible = false;
  let axesVisible = false;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;

  let triangleMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
  let triangleGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let originalMaterials: InstanceType<ThreeModule["Material"]>[] = [];
  let materialByGltfIndex = new Map<number | null, number>();
  let neutralMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let vertexColorMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let nodeColorMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
  let allTriangleMaterials: InstanceType<ThreeModule["Material"]>[] = [];

  let lineSegmentsObj: InstanceType<ThreeModule["LineSegments"]> | null = null;
  let lineGeometryObj: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let lineMaterial: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;
  let pointsObj: InstanceType<ThreeModule["Points"]> | null = null;
  let pointGeometryObj: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
  let pointMaterial: InstanceType<ThreeModule["PointsMaterial"]> | null = null;

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
    nodeColorMaterial?.dispose();
    nodeColorMaterial = null;
    allTriangleMaterials = [];
  }

  function disposeCurrentModel(): void {
    if (triangleMesh && viewport) viewport.scene.remove(triangleMesh);
    triangleGeometry?.dispose();
    triangleGeometry = null;
    triangleMesh = null;
    disposeMaterials();
    disposeTextures();
    nodeColorArrayCache = null;

    if (lineSegmentsObj && viewport) viewport.scene.remove(lineSegmentsObj);
    lineGeometryObj?.dispose();
    lineMaterial?.dispose();
    lineSegmentsObj = null;
    lineGeometryObj = null;
    lineMaterial = null;

    if (pointsObj && viewport) viewport.scene.remove(pointsObj);
    pointGeometryObj?.dispose();
    pointMaterial?.dispose();
    pointsObj = null;
    pointGeometryObj = null;
    pointMaterial = null;

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
      if (segment.renderCategory === "triangles" && !surfacesVisible) return;
      if (segment.renderCategory === "lines" && !linesVisible) return;
      if (segment.renderCategory === "points" && !pointsVisible) return;
      boundsList.push(segment.bounds);
    });
    const combined = unionBounds(boundsList);
    if (!combined) return;
    fitCameraAndControls(boundsRadius(combined), combined.center);
  }

  // --- Triangle visibility + per-primitive material groups (rebuilt together, never independently) ---

  function rebuildTriangleGeometry(): void {
    if (!triangleGeometry || !lastResult || !THREE) return;
    const segments = lastResult.segments;
    const fullIndices = lastResult.indices;

    let total = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory === "triangles" && !hiddenSegmentIndices.has(i)) total += segment.indexCount;
    });

    const newIndex = new Uint32Array(total);
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    let offset = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory !== "triangles" || hiddenSegmentIndices.has(i)) return;
      for (let k = 0; k < segment.indexCount; k++) newIndex[offset + k] = fullIndices[segment.indexStart + k];
      const materialArrayIndex = materialByGltfIndex.get(segment.materialIndex) ?? 0;
      groups.push({ start: offset, count: segment.indexCount, materialIndex: materialArrayIndex });
      offset += segment.indexCount;
    });

    triangleGeometry.setIndex(new THREE.BufferAttribute(newIndex, 1));
    triangleGeometry.clearGroups();
    for (const g of groups) triangleGeometry.addGroup(g.start, g.count, g.materialIndex);
    viewport?.requestRender();
  }

  function rebuildLineIndex(): void {
    if (!lineGeometryObj || !lastResult || !THREE) return;
    const segments = lastResult.segments;
    let total = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory === "lines" && !hiddenSegmentIndices.has(i)) total += segment.indexCount * 2;
    });
    const index = new Uint32Array(total);
    let offset = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory !== "lines" || hiddenSegmentIndices.has(i)) return;
      const start = segment.indexStart * 2;
      const count = segment.indexCount * 2;
      for (let k = 0; k < count; k++) index[offset + k] = start + k;
      offset += count;
    });
    lineGeometryObj.setIndex(new THREE.BufferAttribute(index, 1));
    viewport?.requestRender();
  }

  function rebuildPointIndex(): void {
    if (!pointGeometryObj || !lastResult || !THREE) return;
    const segments = lastResult.segments;
    let total = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory === "points" && !hiddenSegmentIndices.has(i)) total += segment.indexCount;
    });
    const index = new Uint32Array(total);
    let offset = 0;
    segments.forEach((segment, i) => {
      if (segment.renderCategory !== "points" || hiddenSegmentIndices.has(i)) return;
      for (let k = 0; k < segment.indexCount; k++) index[offset + k] = segment.indexStart + k;
      offset += segment.indexCount;
    });
    pointGeometryObj.setIndex(new THREE.BufferAttribute(index, 1));
    viewport?.requestRender();
  }

  function rebuildVisibility(): void {
    rebuildTriangleGeometry();
    rebuildLineIndex();
    rebuildPointIndex();
  }

  // --- Textures and materials ---

  function mapWrap(three: ThreeModule, value: number): Wrapping {
    if (value === WRAP_CLAMP) return three.ClampToEdgeWrapping;
    if (value === WRAP_MIRROR) return three.MirroredRepeatWrapping;
    return three.RepeatWrapping;
  }

  function mapMagFilter(three: ThreeModule, value: number | null): MagnificationTextureFilter {
    return value === FILTER_NEAREST ? three.NearestFilter : three.LinearFilter;
  }

  function mapMinFilter(three: ThreeModule, value: number | null): MinificationTextureFilter {
    switch (value) {
      case FILTER_NEAREST:
        return three.NearestFilter;
      case FILTER_NEAREST_MIPMAP_NEAREST:
        return three.NearestMipmapNearestFilter;
      case FILTER_LINEAR_MIPMAP_NEAREST:
        return three.LinearMipmapNearestFilter;
      case FILTER_NEAREST_MIPMAP_LINEAR:
        return three.NearestMipmapLinearFilter;
      default:
        return three.LinearMipmapLinearFilter;
    }
  }

  async function decodeImages(result: GLBViewerResult): Promise<void> {
    decodedBitmaps = [];
    let unavailable = false;
    for (const image of result.images) {
      if (!image) {
        decodedBitmaps.push(null);
        continue;
      }
      if (typeof createImageBitmap !== "function") {
        decodedBitmaps.push(null);
        unavailable = true;
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
    if (unavailable && !decodeWarningShown) {
      decodeWarningShown = true;
    }
  }

  let decodeWarningShown = false;

  function buildTextureFor(textureDescriptor: GLBViewerTexture): InstanceType<ThreeModule["Texture"]> | null {
    if (!THREE || textureDescriptor.sourceImageIndex === null) return null;
    const bitmap = decodedBitmaps[textureDescriptor.sourceImageIndex];
    if (!bitmap) return null;

    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = mapWrap(THREE, textureDescriptor.sampler.wrapS);
    texture.wrapT = mapWrap(THREE, textureDescriptor.sampler.wrapT);
    texture.magFilter = mapMagFilter(THREE, textureDescriptor.sampler.magFilter);
    texture.minFilter = mapMinFilter(THREE, textureDescriptor.sampler.minFilter);
    texture.needsUpdate = true;
    decodedTextures.push(texture);
    return texture;
  }

  function buildMaterialFromDescriptor(desc: GLBViewerMaterial, result: GLBViewerResult): InstanceType<ThreeModule["Material"]> {
    if (!THREE) throw new Error("THREE not loaded");

    let map: InstanceType<ThreeModule["Texture"]> | null = null;
    if (desc.baseColorTexture) {
      const textureDescriptor = result.textures[desc.baseColorTexture.textureIndex];
      if (textureDescriptor) map = buildTextureFor(textureDescriptor);
    }

    const common = {
      color: new THREE.Color(desc.baseColorFactor[0], desc.baseColorFactor[1], desc.baseColorFactor[2]),
      map,
      transparent: desc.alphaMode === "BLEND",
      opacity: desc.baseColorFactor[3],
      alphaTest: desc.alphaMode === "MASK" ? desc.alphaCutoff : 0,
      side: desc.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: result.hasVertexColors,
      wireframe: currentWireframe,
    };

    if (desc.unlit) {
      return new THREE.MeshBasicMaterial(common);
    }
    return new THREE.MeshStandardMaterial({
      ...common,
      metalness: desc.metallicFactor,
      roughness: desc.roughnessFactor,
      emissive: new THREE.Color(desc.emissiveFactor[0], desc.emissiveFactor[1], desc.emissiveFactor[2]),
      flatShading: shadingMode === "flat",
    });
  }

  function buildOriginalMaterials(result: GLBViewerResult): void {
    if (!THREE) return;
    materialByGltfIndex = new Map();
    originalMaterials = [];

    const triangleSegments = result.segments.filter((s) => s.renderCategory === "triangles");
    for (const segment of triangleSegments) {
      if (materialByGltfIndex.has(segment.materialIndex)) continue;
      materialByGltfIndex.set(segment.materialIndex, originalMaterials.length);
      const material =
        segment.materialIndex !== null
          ? buildMaterialFromDescriptor(result.materials[segment.materialIndex], result)
          : new THREE.MeshStandardMaterial({ color: currentColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: currentWireframe });
      originalMaterials.push(material);
    }
    if (originalMaterials.length === 0) {
      materialByGltfIndex.set(null, 0);
      originalMaterials.push(new THREE.MeshStandardMaterial({ color: currentColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide }));
    }
  }

  function buildNodeColorArray(result: GLBViewerResult): Float32Array {
    const array = new Float32Array((result.positions.length / 3) * 4);
    array.fill(1); // default white
    for (const segment of result.segments) {
      if (segment.renderCategory !== "triangles") continue;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (let k = 0; k < segment.indexCount; k++) {
        const idx = result.indices[segment.indexStart + k];
        if (idx < vMin) vMin = idx;
        if (idx > vMax) vMax = idx;
      }
      if (!Number.isFinite(vMin)) continue;
      const [r, g, b] = hexToRGB01(NODE_COLOR_PALETTE[hashString(String(segment.nodeIndex)) % NODE_COLOR_PALETTE.length]);
      for (let v = vMin; v <= vMax; v++) {
        array[v * 4] = r;
        array[v * 4 + 1] = g;
        array[v * 4 + 2] = b;
        array[v * 4 + 3] = 1;
      }
    }
    return array;
  }

  function applyColorMode(): void {
    if (!triangleMesh || !triangleGeometry || !THREE || !lastResult) return;

    if (colorMode === "original") {
      triangleGeometry.deleteAttribute("color");
      if (lastResult.colors0) triangleGeometry.setAttribute("color", new THREE.BufferAttribute(lastResult.colors0, 4));
      triangleMesh.material = originalMaterials;
    } else if (colorMode === "neutral") {
      if (!neutralMaterial) {
        neutralMaterial = new THREE.MeshStandardMaterial({ color: currentColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" });
        allTriangleMaterials.push(neutralMaterial);
      } else {
        neutralMaterial.color.set(currentColorHex);
      }
      triangleMesh.material = neutralMaterial;
    } else if (colorMode === "vertex-colors" && lastResult.hasVertexColors) {
      if (!vertexColorMaterial) {
        vertexColorMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" });
        allTriangleMaterials.push(vertexColorMaterial);
      }
      triangleGeometry.deleteAttribute("color");
      if (lastResult.colors0) triangleGeometry.setAttribute("color", new THREE.BufferAttribute(lastResult.colors0, 4));
      triangleMesh.material = vertexColorMaterial;
    } else if (colorMode === "node") {
      if (!nodeColorArrayCache) nodeColorArrayCache = buildNodeColorArray(lastResult);
      triangleGeometry.deleteAttribute("color");
      triangleGeometry.setAttribute("color", new THREE.BufferAttribute(nodeColorArrayCache, 4));
      if (!nodeColorMaterial) {
        nodeColorMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide, wireframe: currentWireframe, flatShading: shadingMode === "flat" });
        allTriangleMaterials.push(nodeColorMaterial);
      }
      triangleMesh.material = nodeColorMaterial;
    }
    viewport?.requestRender();
  }

  function applyShadingMode(): void {
    const flat = shadingMode === "flat";
    for (const m of [...originalMaterials, ...allTriangleMaterials]) {
      if ("flatShading" in m) {
        (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).flatShading = flat;
        m.needsUpdate = true;
      }
    }
    viewport?.requestRender();
  }

  function setupDisplayControls(result: GLBViewerResult): void {
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

    surfacesVisible = true;
    linesVisible = true;
    pointsVisible = true;
    const hasTriangles = result.renderedTriangleCount > 0;
    const hasLines = result.renderedLineCount > 0;
    const hasPoints = result.renderedPointCount > 0;
    surfacesButton.hidden = !(hasTriangles && (hasLines || hasPoints));
    linesButton.hidden = !hasLines;
    pointsButton.hidden = !hasPoints;
    surfacesButton.setAttribute("aria-pressed", "true");
    surfacesButton.textContent = "Hide surfaces";
    linesButton.setAttribute("aria-pressed", "true");
    linesButton.textContent = "Hide lines";
    pointsButton.setAttribute("aria-pressed", "true");
    pointsButton.textContent = "Hide points";
  }

  function buildSceneFromResult(result: GLBViewerResult): void {
    if (!viewport || !THREE) return;
    disposeCurrentModel();

    if (result.renderedTriangleCount > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
      if (result.texcoords0) geometry.setAttribute("uv", new THREE.BufferAttribute(result.texcoords0, 2));

      buildOriginalMaterials(result);
      const mesh = new THREE.Mesh(geometry, originalMaterials);
      viewport.scene.add(mesh);
      triangleMesh = mesh;
      triangleGeometry = geometry;
      rebuildTriangleGeometry();
    }

    if (result.lineGeometry) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(result.lineGeometry, 3));
      if (result.lineColors) geometry.setAttribute("color", new THREE.BufferAttribute(result.lineColors, 3));
      const material = new THREE.LineBasicMaterial({ color: "#24b8d8", vertexColors: Boolean(result.lineColors) });
      const lines = new THREE.LineSegments(geometry, material);
      lines.visible = linesVisible;
      viewport.scene.add(lines);
      lineSegmentsObj = lines;
      lineGeometryObj = geometry;
      lineMaterial = material;
      rebuildLineIndex();
    }

    if (result.pointGeometry) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(result.pointGeometry, 3));
      if (result.pointColors) geometry.setAttribute("color", new THREE.BufferAttribute(result.pointColors, 3));
      const material = new THREE.PointsMaterial({ color: "#ed4b93", size: 4, sizeAttenuation: false, vertexColors: Boolean(result.pointColors) });
      const points = new THREE.Points(geometry, material);
      points.visible = pointsVisible;
      viewport.scene.add(points);
      pointsObj = points;
      pointGeometryObj = geometry;
      pointMaterial = material;
      rebuildPointIndex();
    }

    hiddenSegmentIndices.clear();
    applyColorMode();
    applyShadingMode();

    lastFullRadius = boundsRadius(result.boundsMeters);
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

  function renderBounds(result: GLBViewerResult): void {
    const b = result.boundsMeters;
    infoWidthM.textContent = `${formatMagnitude(b.size[0])} m`;
    infoHeightM.textContent = `${formatMagnitude(b.size[1])} m`;
    infoDepthM.textContent = `${formatMagnitude(b.size[2])} m`;
    infoWidthMm.textContent = `${formatMagnitude(b.size[0] * 1000)} mm`;
    infoHeightMm.textContent = `${formatMagnitude(b.size[1] * 1000)} mm`;
    infoDepthMm.textContent = `${formatMagnitude(b.size[2] * 1000)} mm`;
  }

  function renderWarnings(warnings: GLBViewerWarning[]): void {
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

  function renderInfo(result: GLBViewerResult): void {
    infoFilesize.textContent = formatFileSize(lastFileSize);
    infoVersion.textContent = result.gltfVersion;
    infoSceneName.textContent = result.selectedSceneName ?? "(unnamed)";
    infoSceneCount.textContent = String(result.sceneCount);
    infoNodeCount.textContent = String(result.nodeCount);
    infoMeshCount.textContent = String(result.meshCount);
    infoPrimitiveCount.textContent = String(result.primitiveCount);
    infoNodeInstances.textContent = formatTriangleCount(result.nodeInstanceCount);
    infoSourceVertices.textContent = formatTriangleCount(result.sourceVertexCount);
    infoTriangles.textContent = formatTriangleCount(result.renderedTriangleCount);
    infoLines.textContent = formatTriangleCount(result.renderedLineCount);
    infoPoints.textContent = formatTriangleCount(result.renderedPointCount);
    infoMaterials.textContent = String(result.materials.length);
    infoTextures.textContent = String(result.textures.length);
    infoImages.textContent = String(result.images.filter((i) => i !== null).length);
    infoAnimations.textContent = String(result.animationCount);
    infoSkins.textContent = String(result.skinCount);
    infoMorphTargets.textContent = String(result.morphTargetCount);
    infoSourceNormals.textContent = result.hasSourceNormals ? "Present and used" : "Not available";
    infoTangents.textContent = result.hasTangents ? `Present (${formatTriangleCount(result.tangentCount)})` : "Not available";
    infoVertexColors.textContent = result.hasVertexColors ? "Present" : "Not available";
    renderBounds(result);

    infoExtensions.textContent =
      result.extensionsUsed.length > 0 || result.extensionsRequired.length > 0
        ? `Extensions used: ${result.extensionsUsed.join(", ") || "none"}. Required: ${result.extensionsRequired.join(", ") || "none"}.`
        : "No glTF extensions declared.";

    renderWarnings(result.warnings);
    modelInfo.hidden = false;
  }

  function renderMaterials(result: GLBViewerResult): void {
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
      const [r, g, b] = material.baseColorFactor;
      swatch.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

      const details = document.createElement("div");
      details.className = "glb-material-details";
      const name = document.createElement("p");
      name.className = "glb-material-name";
      name.textContent = material.name ?? "(unnamed material)";
      const meta = document.createElement("p");
      meta.className = "glb-material-meta";
      const parts = [
        `Metalness ${material.metallicFactor.toFixed(2)}`,
        `Roughness ${material.roughnessFactor.toFixed(2)}`,
        material.alphaMode,
        material.doubleSided ? "double-sided" : "single-sided",
        material.unlit ? "unlit" : null,
        material.baseColorTexture ? "base-color texture" : null,
      ].filter((p): p is string => p !== null);
      meta.textContent = parts.join(" · ");

      details.append(name, meta);
      card.append(swatch, details);
      materialList.appendChild(card);
    });
  }

  function renderSceneTree(result: GLBViewerResult): void {
    sceneTree.hidden = false;
    sceneTreeList.textContent = "";

    const segments = result.segments;
    const rendered = segments.slice(0, MAX_RENDERED_SEGMENT_ROWS);
    const overflow = segments.length - rendered.length;

    sceneTreeNote.textContent =
      overflow > 0
        ? `Showing ${rendered.length} of ${segments.length} primitives individually. "Show all" and "Hide all" apply to every one.`
        : `${segments.length} rendered ${segments.length === 1 ? "primitive" : "primitives"}.`;

    const nodeOrder: number[] = [];
    const byNode = new Map<number, { segment: GLBViewerSegment; index: number }[]>();
    rendered.forEach((segment, index) => {
      if (!byNode.has(segment.nodeIndex)) {
        byNode.set(segment.nodeIndex, []);
        nodeOrder.push(segment.nodeIndex);
      }
      byNode.get(segment.nodeIndex)!.push({ segment, index });
    });

    for (const nodeIndex of nodeOrder) {
      const wrap = document.createElement("div");
      wrap.className = "scene-tree-object-group";
      const rows = byNode.get(nodeIndex)!;
      const heading = document.createElement("p");
      heading.className = "scene-tree-object-name";
      heading.textContent = rows[0].segment.displayName ?? `Node ${nodeIndex}`;
      wrap.appendChild(heading);

      for (const { segment, index } of rows) {
        const row = document.createElement("div");
        row.className = "scene-tree-row";

        const checkboxId = `glb-viewer-segment-${index}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = checkboxId;
        checkbox.checked = !hiddenSegmentIndices.has(index);
        const structuralLabel = buildSegmentStructuralLabel(segment.nodeIndex, segment.meshIndex, segment.primitiveIndex);
        checkbox.setAttribute("aria-label", `Show ${structuralLabel}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenSegmentIndices.delete(index);
          else hiddenSegmentIndices.add(index);
          rebuildVisibility();
        });

        const label = document.createElement("label");
        label.className = "scene-tree-row-label";
        label.setAttribute("for", checkboxId);
        const materialName = segment.materialIndex !== null ? result.materials[segment.materialIndex]?.name : null;
        label.textContent = `Primitive ${segment.primitiveIndex} (${segment.renderCategory})${materialName ? ` · ${materialName}` : ""}`;

        const count = document.createElement("span");
        count.className = "scene-tree-row-count";
        count.textContent = formatTriangleCount(segment.indexCount);

        const isolateButton = document.createElement("button");
        isolateButton.type = "button";
        isolateButton.className = "scene-tree-isolate";
        isolateButton.textContent = "Isolate";
        isolateButton.addEventListener("click", () => {
          hiddenSegmentIndices = new Set(segments.map((_, segmentIndex) => segmentIndex).filter((segmentIndex) => segmentIndex !== index));
          rebuildVisibility();
          renderSceneTree(result);
        });

        row.append(checkbox, label, count, isolateButton);
        wrap.appendChild(row);
      }

      sceneTreeList.appendChild(wrap);
    }
  }

  async function renderResult(result: GLBViewerResult): Promise<void> {
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
      showError(
        isSafeError(error) ? error : { code: "WEBGL_UNAVAILABLE", message: "The 3D viewer couldn't start.", recoverable: false },
      );
      setState("error");
    }
  }

  function createGLBViewerWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/glb-viewer.worker.ts", import.meta.url), { type: "module" });
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
    workerClient = new WorkerClient(createGLBViewerWorker, {
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
        void renderResult(result as GLBViewerResult);
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

    const config: FileValidationConfig = { allowedExtensions: ["glb"], maxSizeBytes: MAX_SIZE_BYTES };
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
    for (const m of [...originalMaterials, ...allTriangleMaterials]) {
      (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).wireframe = currentWireframe;
    }
    viewport?.requestRender();
  });

  colorModeSelect.addEventListener("change", () => {
    const value = colorModeSelect.value;
    colorMode = value === "neutral" || value === "vertex-colors" || value === "node" ? value : "original";
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

  surfacesButton.addEventListener("click", () => {
    surfacesVisible = !surfacesVisible;
    surfacesButton.setAttribute("aria-pressed", String(surfacesVisible));
    surfacesButton.textContent = surfacesVisible ? "Hide surfaces" : "Show surfaces";
    if (triangleMesh) {
      triangleMesh.visible = surfacesVisible;
      viewport?.requestRender();
    }
  });
  linesButton.addEventListener("click", () => {
    linesVisible = !linesVisible;
    linesButton.setAttribute("aria-pressed", String(linesVisible));
    linesButton.textContent = linesVisible ? "Hide lines" : "Show lines";
    if (lineSegmentsObj) {
      lineSegmentsObj.visible = linesVisible;
      viewport?.requestRender();
    }
  });
  pointsButton.addEventListener("click", () => {
    pointsVisible = !pointsVisible;
    pointsButton.setAttribute("aria-pressed", String(pointsVisible));
    pointsButton.textContent = pointsVisible ? "Hide points" : "Show points";
    if (pointsObj) {
      pointsObj.visible = pointsVisible;
      viewport?.requestRender();
    }
  });

  showAllButton.addEventListener("click", () => {
    hiddenSegmentIndices.clear();
    rebuildVisibility();
    if (lastResult) renderSceneTree(lastResult);
  });
  hideAllButton.addEventListener("click", () => {
    if (!lastResult) return;
    hiddenSegmentIndices = new Set(lastResult.segments.map((_, index) => index));
    rebuildVisibility();
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
