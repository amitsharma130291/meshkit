/**
 * Orchestration for the G-code Cluster — the SHARED implementation
 * behind all five intent routes (`/gcode-viewer/`, `/gcode-visualizer/`,
 * `/gcode-simulator/`, `/gcode-layer-viewer/`, `/gcode-toolpath-viewer/`).
 * Every route's own `<script>` tag imports this exact module.
 *
 * This is a VISUAL toolpath viewer/simulator only. It never executes
 * G-code, never connects to a printer, never uses WebSerial, and never
 * claims that visual playback exactly reproduces physical printer
 * motion — see `docs/ARCHITECTURE.md`'s "G-code Cluster (Phase 9)"
 * section for the full architecture and these same disclosures.
 *
 * Rendering strategy: the worker returns typed-array render buffers
 * (`src/lib/gcode/geometry.ts`'s `RenderBuffers`) already packed once.
 * Whenever a visibility toggle, color mode, or layer selection changes,
 * this module does ONE pass over those already-in-memory typed arrays
 * to build a FILTERED position+color buffer and calls `setDrawRange` —
 * never a rebuild per G-code move, and never one Three.js object per
 * move.
 */
import { isSafeError, type SafeError } from "../../lib/errors";
import { getCapabilityReport } from "../../lib/browser/capabilities";
import { FileSession } from "../../lib/files/file-session";
import { validateSelectedFile, type FileValidationConfig } from "../../lib/files/validation";
import { sanitizeDownloadBasename, buildScreenshotFilename } from "../../lib/files/download";
import { formatFileSize } from "../../lib/stl/format";
import { TOOL_STATE_LABELS, type ToolState } from "../../lib/tool-state";
import { WorkerClient, type WorkerLike } from "../../lib/workers/worker-client";
import type { AnalyzeResult } from "../../lib/gcode/analyze";
import { buildDownloadableGCodeReport } from "../../lib/gcode/report";
import {
  formatGCodeStatus,
  formatLayerDetectionMode,
  formatSlicer,
  formatDurationSeconds,
  formatDistanceMm,
} from "../../lib/gcode/formatting";
import { MOVE_CATEGORY_CODES, FEATURE_CATEGORY_CODES, type RenderChunk } from "../../lib/gcode/geometry";
import { temperatureColor, isTemperatureModeAvailable } from "../../lib/gcode/color-scale";
import {
  createPlaybackState,
  play as playbackPlay,
  pause as playbackPause,
  resume as playbackResume,
  restart as playbackRestart,
  seek as playbackSeek,
  advance as playbackAdvance,
  stepForward as playbackStepForward,
  stepBackward as playbackStepBackward,
  setPlaybackRate as playbackSetRate,
  replaceMoveCount as playbackReplaceMoveCount,
  teardown as playbackTeardown,
  type PlaybackState,
} from "../../lib/gcode/playback";

type ThreeModule = typeof import("three");
type ToolViewportCtor = typeof import("../../lib/three/viewport").ToolViewport;
type OrbitControlsCtor = typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

const MAX_SIZE_BYTES = 400 * 1024 * 1024;

const STAGE_LABELS: Record<string, string> = {
  "Reading file": "Reading file…",
  "Parsing commands": "Parsing commands…",
  "Resolving motion": "Resolving motion…",
  "Detecting layers": "Detecting layers…",
  "Classifying toolpaths": "Classifying toolpaths…",
  "Building render buffers": "Building render buffers…",
  "Computing statistics": "Computing statistics…",
  Ready: "Finishing up…",
};

type ColorMode = "feature" | "movement" | "tool" | "layer" | "feed-rate" | "temperature";
type LayerViewMode = "single" | "cumulative" | "all";

const FEATURE_COLORS: Record<number, [number, number, number]> = {
  [FEATURE_CATEGORY_CODES["outer-wall"]]: [0.78, 0.25, 0.32],
  [FEATURE_CATEGORY_CODES["inner-wall"]]: [0.95, 0.55, 0.2],
  [FEATURE_CATEGORY_CODES.infill]: [0.25, 0.6, 0.9],
  [FEATURE_CATEGORY_CODES["solid-infill"]]: [0.15, 0.45, 0.75],
  [FEATURE_CATEGORY_CODES["top-surface"]]: [0.9, 0.85, 0.2],
  [FEATURE_CATEGORY_CODES["bottom-surface"]]: [0.7, 0.65, 0.15],
  [FEATURE_CATEGORY_CODES.support]: [0.55, 0.55, 0.55],
  [FEATURE_CATEGORY_CODES["support-interface"]]: [0.4, 0.4, 0.4],
  [FEATURE_CATEGORY_CODES.bridge]: [0.85, 0.3, 0.85],
  [FEATURE_CATEGORY_CODES.skirt]: [0.3, 0.75, 0.4],
  [FEATURE_CATEGORY_CODES.brim]: [0.35, 0.8, 0.5],
  [FEATURE_CATEGORY_CODES.raft]: [0.45, 0.35, 0.2],
  [FEATURE_CATEGORY_CODES.purge]: [0.6, 0.3, 0.15],
  [FEATURE_CATEGORY_CODES["prime-tower"]]: [0.5, 0.2, 0.6],
  [FEATURE_CATEGORY_CODES.custom]: [0.5, 0.5, 0.7],
  [FEATURE_CATEGORY_CODES["unknown-extrusion"]]: [0.6, 0.6, 0.6],
  [FEATURE_CATEGORY_CODES.travel]: [0.75, 0.75, 0.8],
};

const MOVEMENT_COLORS: Record<number, [number, number, number]> = {
  [MOVE_CATEGORY_CODES.extrusion]: [0.78, 0.25, 0.32],
  [MOVE_CATEGORY_CODES.travel]: [0.75, 0.75, 0.8],
  [MOVE_CATEGORY_CODES.retract]: [0.9, 0.6, 0.1],
  [MOVE_CATEGORY_CODES["e-only-extrusion"]]: [0.78, 0.25, 0.32],
  [MOVE_CATEGORY_CODES["e-only-retract"]]: [0.9, 0.6, 0.1],
  [MOVE_CATEGORY_CODES["z-only"]]: [0.5, 0.8, 0.9],
  [MOVE_CATEGORY_CODES["zero-length-state-update"]]: [0.6, 0.6, 0.6],
};

const TOOL_PALETTE: [number, number, number][] = [
  [0.78, 0.25, 0.32],
  [0.25, 0.6, 0.9],
  [0.3, 0.75, 0.4],
  [0.9, 0.6, 0.1],
  [0.6, 0.3, 0.8],
  [0.2, 0.8, 0.7],
];

function toolColor(tool: number): [number, number, number] {
  return TOOL_PALETTE[tool % TOOL_PALETTE.length];
}

function layerColor(layerIndex: number, totalLayers: number): [number, number, number] {
  const t = totalLayers > 1 ? layerIndex / (totalLayers - 1) : 0;
  const hue = (1 - t) * 0.75; // blue (low layers) -> red (high layers)
  return hslToRgb(hue, 0.65, 0.5);
}

function feedRateColor(feedRate: number, min: number, max: number): [number, number, number] {
  if (!Number.isFinite(feedRate) || max <= min) return [0.6, 0.6, 0.6];
  const t = Math.max(0, Math.min(1, (feedRate - min) / (max - min)));
  const hue = 0.6 - t * 0.6; // blue (slow) -> red (fast)
  return hslToRgb(hue, 0.7, 0.5);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
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

  const resetCameraButton = document.querySelector<HTMLButtonElement>('[data-action="reset-camera"]')!;
  const fitModelButton = document.querySelector<HTMLButtonElement>('[data-action="fit-model"]')!;
  const colorModeSelect = document.querySelector<HTMLSelectElement>('[data-action="color-mode"]')!;
  const toggleExtrusionButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-extrusion"]')!;
  const toggleTravelButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-travel"]')!;
  const toggleRetractButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-retract-markers"]')!;
  const toolVisibilityContainer = document.querySelector<HTMLElement>("[data-tool-visibility]")!;
  const opacityInput = document.querySelector<HTMLInputElement>('[data-action="opacity"]')!;
  const gridButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-scene-grid"]')!;
  const axesButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-axes"]')!;
  const backgroundSelect = document.querySelector<HTMLSelectElement>('[data-action="background"]')!;
  const screenshotButton = document.querySelector<HTMLButtonElement>('[data-action="screenshot"]')!;
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-file"]')!;

  const layerModeSingleButton = document.querySelector<HTMLButtonElement>('[data-action="layer-mode-single"]')!;
  const layerModeCumulativeButton = document.querySelector<HTMLButtonElement>('[data-action="layer-mode-cumulative"]')!;
  const layerModeAllButton = document.querySelector<HTMLButtonElement>('[data-action="layer-mode-all"]')!;
  const layerScrubInput = document.querySelector<HTMLInputElement>('[data-action="layer-scrub"]')!;
  const currentLayerLabel = document.querySelector<HTMLElement>("[data-current-layer]")!;
  const maxLayerLabel = document.querySelector<HTMLElement>("[data-max-layer]")!;
  const layerDetectionNote = document.querySelector<HTMLElement>("[data-layer-detection-note]")!;

  const playPauseButton = document.querySelector<HTMLButtonElement>('[data-action="play-pause"]')!;
  const restartButton = document.querySelector<HTMLButtonElement>('[data-action="restart"]')!;
  const stepBackButton = document.querySelector<HTMLButtonElement>('[data-action="step-backward"]')!;
  const stepForwardButton = document.querySelector<HTMLButtonElement>('[data-action="step-forward"]')!;
  const progressScrub = document.querySelector<HTMLInputElement>('[data-action="progress-scrub"]')!;
  const playbackRateSelect = document.querySelector<HTMLSelectElement>('[data-action="playback-rate"]')!;
  const currentCommandLabel = document.querySelector<HTMLElement>("[data-current-command]")!;
  const currentPositionLabel = document.querySelector<HTMLElement>("[data-current-position]")!;
  const currentELabel = document.querySelector<HTMLElement>("[data-current-e]")!;
  const currentFeedRateLabel = document.querySelector<HTMLElement>("[data-current-feed-rate]")!;
  const currentElapsedLabel = document.querySelector<HTMLElement>("[data-current-elapsed]")!;

  const downloadReportButton = document.querySelector<HTMLButtonElement>('[data-action="download-gcode-report"]')!;

  let currentSession: FileSession | null = null;
  let workerClient: WorkerClient | null = null;
  let workerReady = false;
  let lastResult: AnalyzeResult | null = null;

  let THREE: ThreeModule | null = null;
  let viewport: InstanceType<ToolViewportCtor> | null = null;
  let orbitControls: InstanceType<OrbitControlsCtor> | null = null;
  let dampingActive = false;
  let dampingStopTimer: number | null = null;
  let gridHelper: InstanceType<ThreeModule["GridHelper"]> | null = null;
  let axesHelper: InstanceType<ThreeModule["AxesHelper"]> | null = null;

  let lineSegments: InstanceType<ThreeModule["LineSegments"]>[] = [];
  let toolheadMarker: InstanceType<ThreeModule["Mesh"]> | null = null;
  let lastRadius: number | null = null;

  let colorMode: ColorMode = "feature";
  let showExtrusion = true;
  let showTravel = true;
  let showRetractMarkers = false;
  let visibleTools = new Set<number>();
  let layerViewMode: LayerViewMode = "single";
  let currentLayer = 0;
  let layerRangeStart = 0;
  let layerRangeEnd = 0;

  let playback: PlaybackState = createPlaybackState(0);
  let playbackAnimHandle: number | null = null;
  let playbackLastFrameTime = 0;

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

  function stopDampingLoop(): void {
    dampingActive = false;
    if (dampingStopTimer !== null) {
      window.clearTimeout(dampingStopTimer);
      dampingStopTimer = null;
    }
  }

  function disposeLineSegments(): void {
    if (!viewport) return;
    for (const obj of lineSegments) {
      viewport.scene.remove(obj);
      obj.geometry.dispose();
      (obj.material as InstanceType<ThreeModule["Material"]>).dispose();
    }
    lineSegments = [];
    disposeToolheadMarker();
  }

  function disposeToolheadMarker(): void {
    if (!viewport || !toolheadMarker) return;
    viewport.scene.remove(toolheadMarker);
    toolheadMarker.geometry.dispose();
    (toolheadMarker.material as InstanceType<ThreeModule["Material"]>).dispose();
    toolheadMarker = null;
  }

  function ensureToolheadMarker(): void {
    if (!viewport || !THREE || toolheadMarker) return;
    const geometry = new THREE.SphereGeometry(Math.max((lastRadius ?? 1) * 0.015, 0.05), 12, 12);
    const material = new THREE.MeshBasicMaterial({ color: "#00e5ff", depthTest: false });
    toolheadMarker = new THREE.Mesh(geometry, material);
    toolheadMarker.renderOrder = 999;
    viewport.scene.add(toolheadMarker);
  }

  function disposeViewer(): void {
    stopDampingLoop();
    stopPlaybackLoop();
    disposeLineSegments();
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

    const safeRadius = Math.max(radius, 1e-6);
    const camera = viewport.camera;
    const fovRad = (camera.fov * Math.PI) / 180;
    const distance = (safeRadius / Math.sin(fovRad / 2)) * 1.35;
    const direction = new THREE.Vector3(0.6, 1, 1).normalize();
    camera.position.set(center[0], center[1], center[2]).add(direction.multiplyScalar(distance));
    camera.near = Math.max(distance / 1000, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    orbitControls.target.set(center[0], center[1], center[2]);
    orbitControls.minDistance = safeRadius * 0.05;
    orbitControls.maxDistance = safeRadius * 12;
    orbitControls.enableDamping = wasDamping;
    orbitControls.update();
    viewport.requestRender();
  }

  // --- Color/visibility filtering ----------------------------------------

  function segmentColor(chunk: RenderChunk, i: number): [number, number, number] {
    switch (colorMode) {
      case "feature":
        return FEATURE_COLORS[chunk.featureCodes[i]] ?? [0.6, 0.6, 0.6];
      case "movement":
        return MOVEMENT_COLORS[chunk.categoryCodes[i]] ?? [0.6, 0.6, 0.6];
      case "tool":
        return toolColor(chunk.toolIndices[i]);
      case "layer":
        return layerColor(chunk.layerIndices[i], (lastResult?.layers.length ?? 1) || 1);
      case "feed-rate": {
        const range = lastResult?.statistics.feedRateRange;
        if (!range) return [0.6, 0.6, 0.6];
        return feedRateColor(chunk.feedRates[i], range.min, range.max);
      }
      case "temperature": {
        const range = lastResult?.statistics.temperatureRange;
        if (!range) return [0.6, 0.6, 0.6];
        return temperatureColor(chunk.temperatures[i], range);
      }
    }
  }

  function isSegmentVisible(chunk: RenderChunk, i: number): boolean {
    const category = chunk.categoryCodes[i];
    const isExtrusion = category === MOVE_CATEGORY_CODES.extrusion || category === MOVE_CATEGORY_CODES["e-only-extrusion"];
    const isTravel = category === MOVE_CATEGORY_CODES.travel || category === MOVE_CATEGORY_CODES["z-only"] || category === MOVE_CATEGORY_CODES["zero-length-state-update"];
    const isRetract = category === MOVE_CATEGORY_CODES.retract || category === MOVE_CATEGORY_CODES["e-only-retract"];

    if (isExtrusion && !showExtrusion) return false;
    if (isTravel && !showTravel) return false;
    if (isRetract && !showRetractMarkers && !showExtrusion) return false;

    if (!visibleTools.has(chunk.toolIndices[i])) return false;

    const layerIndex = chunk.layerIndices[i];
    if (layerIndex === -1) return layerViewMode === "all";
    if (layerViewMode === "all") return true;
    if (layerViewMode === "single") return layerIndex === currentLayer;
    return layerIndex >= layerRangeStart && layerIndex <= layerRangeEnd;
  }

  function rebuildVisibleGeometry(): void {
    if (!viewport || !THREE || !lastResult) return;

    for (let c = 0; c < lastResult.render.chunks.length; c++) {
      const chunk = lastResult.render.chunks[c];
      const positions: number[] = [];
      const colors: number[] = [];

      for (let i = 0; i < chunk.segmentCount; i++) {
        if (!isSegmentVisible(chunk, i)) continue;
        const base = i * 6;
        positions.push(chunk.positions[base], chunk.positions[base + 1], chunk.positions[base + 2], chunk.positions[base + 3], chunk.positions[base + 4], chunk.positions[base + 5]);
        const [r, g, b] = segmentColor(chunk, i);
        colors.push(r, g, b, r, g, b);
      }

      const obj = lineSegments[c];
      if (!obj) continue;
      const geometry = obj.geometry;
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
      geometry.setDrawRange(0, positions.length / 3);
      geometry.computeBoundingSphere();
    }

    viewport.requestRender();
  }

  function buildLineSegmentObjects(): void {
    if (!viewport || !THREE || !lastResult) return;
    disposeLineSegments();

    const opacity = Number(opacityInput.value) || 1;
    for (let c = 0; c < lastResult.render.chunks.length; c++) {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity });
      const obj = new THREE.LineSegments(geometry, material);
      viewport.scene.add(obj);
      lineSegments.push(obj);
    }

    rebuildVisibleGeometry();

    const bounds = lastResult.statistics.motionBounds;
    if (bounds) {
      const center: [number, number, number] = [(bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2];
      const radius = Math.max(
        Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) / 2,
        1e-3,
      );
      lastRadius = radius;
      fitCameraAndControls(radius, center);
    }
  }

  // --- Playback ------------------------------------------------------------

  function totalMoveCount(): number {
    return lastResult?.render.totalSegments ?? 0;
  }

  function updatePlaybackUi(): void {
    playPauseButton.textContent = playback.status === "playing" ? "Pause" : "Play";
    playPauseButton.setAttribute("aria-pressed", String(playback.status === "playing"));
    progressScrub.max = String(Math.max(totalMoveCount(), 0));
    progressScrub.value = String(playback.currentMoveIndex);

    const chunks = lastResult?.render.chunks ?? [];
    let remaining = playback.currentMoveIndex;
    let activeChunkIndex = 0;
    let localIndex = 0;
    for (let c = 0; c < chunks.length; c++) {
      if (remaining <= chunks[c].segmentCount) {
        activeChunkIndex = c;
        localIndex = Math.max(0, Math.min(remaining, chunks[c].segmentCount) - 1);
        break;
      }
      remaining -= chunks[c].segmentCount;
    }
    const chunk = chunks[activeChunkIndex];
    if (chunk && totalMoveCount() > 0) {
      currentCommandLabel.textContent = String(playback.currentMoveIndex);
      const base = localIndex * 6;
      const endX = chunk.positions[base + 3];
      const endY = chunk.positions[base + 4];
      const endZ = chunk.positions[base + 5];
      currentPositionLabel.textContent = `${endX.toFixed(2)}, ${endY.toFixed(2)}, ${endZ.toFixed(2)}`;
      currentELabel.textContent = chunk.eDeltas[localIndex].toFixed(4);
      currentFeedRateLabel.textContent = Number.isFinite(chunk.feedRates[localIndex]) ? `${chunk.feedRates[localIndex].toFixed(0)} mm/min` : "—";
      currentElapsedLabel.textContent = formatDurationSeconds(chunk.cumulativeTimeSeconds[localIndex]);
      for (let c = 0; c < lineSegments.length; c++) {
        const drawCount = c < activeChunkIndex ? chunks[c].segmentCount * 2 : c === activeChunkIndex ? (localIndex + 1) * 2 : 0;
        lineSegments[c].geometry.setDrawRange(0, layerViewMode === "all" && playback.status === "idle" ? Infinity : drawCount);
      }
      if (viewport && THREE) {
        ensureToolheadMarker();
        toolheadMarker?.position.set(endX, endY, endZ);
      }
    } else {
      disposeToolheadMarker();
    }
    viewport?.requestRender();
  }

  function stopPlaybackLoop(): void {
    if (playbackAnimHandle !== null) {
      cancelAnimationFrame(playbackAnimHandle);
      playbackAnimHandle = null;
    }
  }

  function startPlaybackLoop(): void {
    if (playbackAnimHandle !== null) return;
    playbackLastFrameTime = performance.now();
    const tick = (time: number): void => {
      const dt = (time - playbackLastFrameTime) / 1000;
      playbackLastFrameTime = time;
      if (playback.status === "playing") {
        const movesPerSecond = 60 * playback.playbackRate;
        playback = playbackAdvance(playback, Math.max(1, Math.round(movesPerSecond * dt)));
        updatePlaybackUi();
      }
      if (playback.status === "playing") {
        playbackAnimHandle = requestAnimationFrame(tick);
      } else {
        playbackAnimHandle = null;
      }
    };
    playbackAnimHandle = requestAnimationFrame(tick);
  }

  // --- Rendering the analysis result ---------------------------------------

  function set(selector: string, text: string): void {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.textContent = text;
  }

  function renderResult(result: AnalyzeResult): void {
    lastResult = result;

    const statusBadge = document.querySelector<HTMLElement>("[data-status-badge]")!;
    statusBadge.dataset.status = result.status;
    set("[data-status-label]", formatGCodeStatus(result.status));

    set("[data-file-size]", formatFileSize(result.statistics.fileBytes));
    set("[data-decoded-lines]", result.statistics.decodedLines.toLocaleString());
    set("[data-dialect]", formatSlicer(result.dialect.slicer));
    set("[data-layer-count]", String(result.layers.length));
    set("[data-layer-detection-mode]", formatLayerDetectionMode(result.layerDetectionMode));
    set("[data-tool-count]", String(result.statistics.tools.length));
    set("[data-linear-moves]", result.statistics.linearMoveCount.toLocaleString());
    set("[data-arc-moves]", result.statistics.arcMoves.toLocaleString());
    set("[data-generated-segments]", result.statistics.generatedSegments.toLocaleString());
    set("[data-unknown-commands]", result.statistics.unknownCommandLines.toLocaleString());
    set("[data-malformed-lines]", result.statistics.malformedLines.toLocaleString());
    set("[data-checksum-summary]", `${result.statistics.checksumValid} valid, ${result.statistics.checksumMissing} missing, ${result.statistics.checksumMismatched} mismatched`);

    const bounds = result.statistics.motionBounds;
    set("[data-bounds-width]", bounds ? formatDistanceMm(bounds.max.x - bounds.min.x) : "—");
    set("[data-bounds-depth]", bounds ? formatDistanceMm(bounds.max.y - bounds.min.y) : "—");
    set("[data-bounds-height]", bounds ? formatDistanceMm(bounds.max.z - bounds.min.z) : "—");

    const nonPlanarNote = document.querySelector<HTMLElement>("[data-non-planar-note]")!;
    if (result.nonPlanarDetected) {
      nonPlanarNote.textContent = "This file's Z height changes almost continuously (consistent with spiral/vase printing) — MeshWrench doesn't claim conventional discrete layers here.";
      nonPlanarNote.hidden = false;
    } else {
      nonPlanarNote.hidden = true;
    }

    // Statistics panel
    set("[data-extrusion-moves]", result.statistics.extrusionMoves.toLocaleString());
    set("[data-travel-moves]", result.statistics.travelMoves.toLocaleString());
    set("[data-retracts]", result.statistics.retracts.toLocaleString());
    set("[data-extrusion-distance]", formatDistanceMm(result.statistics.totalExtrusionDistance));
    set("[data-travel-distance]", formatDistanceMm(result.statistics.totalTravelDistance));
    set("[data-z-travel]", formatDistanceMm(result.statistics.totalZTravel));
    set(
      "[data-feed-rate-range]",
      result.statistics.feedRateRange ? `${result.statistics.feedRateRange.min.toFixed(0)}–${result.statistics.feedRateRange.max.toFixed(0)} mm/min` : "—",
    );
    set("[data-slicer-time]", result.timing.slicerProvidedSeconds !== null ? formatDurationSeconds(result.timing.slicerProvidedSeconds) : "Not declared in this file");
    set("[data-feedrate-time]", formatDurationSeconds(result.timing.feedRateOnlySeconds));
    set("[data-tools-used]", result.statistics.tools.length > 0 ? result.statistics.tools.map((t) => `T${t}`).join(", ") : "—");
    set("[data-bed-temps]", result.statistics.bedTemperatureSetpoints.length > 0 ? result.statistics.bedTemperatureSetpoints.map((t) => `${t}°C`).join(", ") : "—");
    set("[data-fan-changes]", String(result.statistics.fanStateChanges));

    // Warnings
    const warningsList = document.querySelector<HTMLElement>("[data-warnings-list]")!;
    const warningsNone = document.querySelector<HTMLElement>("[data-warnings-none]")!;
    warningsList.textContent = "";
    if (result.warnings.length === 0) {
      warningsNone.hidden = false;
    } else {
      warningsNone.hidden = true;
      for (const w of result.warnings) {
        const li = document.createElement("li");
        li.textContent = w;
        warningsList.appendChild(li);
      }
    }

    // Layer controls
    const maxLayerIndex = Math.max(0, result.layers.length - 1);
    layerScrubInput.max = String(maxLayerIndex);
    layerScrubInput.value = "0";
    currentLayer = 0;
    layerRangeStart = 0;
    layerRangeEnd = maxLayerIndex;
    maxLayerLabel.textContent = String(result.layers.length);
    currentLayerLabel.textContent = result.layers.length > 0 ? "1" : "0";
    layerDetectionNote.textContent =
      result.layerDetectionMode === "explicit"
        ? "Layers from this file's own markers."
        : result.layerDetectionMode === "inferred"
          ? "Layers inferred from height changes — this file didn't declare explicit layer markers."
          : "Layer information isn't available for this file.";

    // Tool visibility checkboxes
    toolVisibilityContainer.textContent = "";
    visibleTools = new Set(result.statistics.tools);
    for (const tool of result.statistics.tools) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "control-button";
      button.textContent = `T${tool}`;
      button.setAttribute("aria-pressed", "true");
      button.addEventListener("click", () => {
        if (visibleTools.has(tool)) visibleTools.delete(tool);
        else visibleTools.add(tool);
        button.setAttribute("aria-pressed", String(visibleTools.has(tool)));
        rebuildVisibleGeometry();
      });
      toolVisibilityContainer.appendChild(button);
    }

    // Playback — replaceMoveCount rather than a fresh createPlaybackState so a
    // reload during the same session preserves the user's own chosen speed.
    stopPlaybackLoop();
    playback = playbackReplaceMoveCount(playback, result.render.totalSegments);
    updatePlaybackUi();

    updateColorModeAvailability();
    updateColorLegend();

    downloadReportButton.disabled = false;

    void (async () => {
      await ensureViewer();
      buildLineSegmentObjects();
    })();
  }

  // --- Worker lifecycle ------------------------------------------------

  function createGCodeWorker(): WorkerLike {
    const worker = new Worker(new URL("../../workers/gcode.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  }

  async function requestProcess(): Promise<void> {
    if (!currentSession || !workerClient || !workerReady) return;
    hideError();
    setState("processing");
    try {
      const buffer = await currentSession.readArrayBuffer();
      workerClient.process(currentSession.file.name, currentSession.extension, buffer, {});
    } catch (error) {
      if (isSafeError(error)) showError(error);
      setState("error");
    }
  }

  async function initWorker(): Promise<void> {
    workerReady = false;
    workerClient = new WorkerClient(createGCodeWorker, {
      onReady: () => {
        workerReady = true;
        if (currentSession) void requestProcess();
      },
      onProgress: (stage) => {
        setState("processing");
        statusLabel.textContent = STAGE_LABELS[stage] ?? TOOL_STATE_LABELS.processing;
        cancelButton.hidden = false;
      },
      onResult: (raw) => {
        cancelButton.hidden = true;
        renderResult(raw as AnalyzeResult);
        setState("success");
        successConfirmation.hidden = false;
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

  function downloadReport(): void {
    if (!lastResult || !currentSession) return;
    const downloadable = buildDownloadableGCodeReport(lastResult, currentSession.file.name, currentSession.file.size);
    const json = JSON.stringify(downloadable, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadBasename(currentSession.file.name)}-gcode-report.json`;
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
    stopPlaybackLoop();
    disposeSession();
    disposeLineSegments();
    fileInput.value = "";
    fileMessage.textContent = "";
    delete fileMessage.dataset.state;
    hideError();
    successConfirmation.hidden = true;
    cancelButton.hidden = true;
    lastRadius = null;
    lastResult = null;
    downloadReportButton.disabled = true;
    playback = playbackTeardown();
    updatePlaybackUi();
    updateColorModeAvailability();
    updateColorLegend();
    setState("idle");
  }

  fileInput.addEventListener("change", () => {
    hideError();
    successConfirmation.hidden = true;

    const file = fileInput.files?.[0];
    if (!file) return;

    const config: FileValidationConfig = { allowedExtensions: ["gcode"], maxSizeBytes: MAX_SIZE_BYTES };
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

    void requestProcess();
  });

  cancelButton.addEventListener("click", () => workerClient?.cancel());

  resetCameraButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });
  fitModelButton.addEventListener("click", () => {
    if (lastRadius !== null) fitCameraAndControls(lastRadius);
  });

  colorModeSelect.addEventListener("change", () => {
    colorMode = colorModeSelect.value as ColorMode;
    rebuildVisibleGeometry();
    updateColorLegend();
  });

  function updateColorModeAvailability(): void {
    const temperatureOption = colorModeSelect.querySelector<HTMLOptionElement>('[data-color-mode-option="temperature"]');
    if (!temperatureOption) return;
    const available = isTemperatureModeAvailable(lastResult?.statistics.temperatureRange ?? null);
    temperatureOption.disabled = !available;
    temperatureOption.hidden = !available;
    if (!available && colorMode === "temperature") {
      colorMode = "feature";
      colorModeSelect.value = "feature";
    }
  }

  function updateColorLegend(): void {
    const legend = document.querySelector<HTMLElement>("[data-color-legend]");
    if (!legend) return;
    if (colorMode === "temperature" && lastResult?.statistics.temperatureRange) {
      const { min, max } = lastResult.statistics.temperatureRange;
      legend.textContent = min === max ? `Constant temperature: ${min}°C` : `Temperature range: ${min}–${max}°C (blue = coolest, red = hottest)`;
      legend.hidden = false;
    } else if (colorMode === "feed-rate" && lastResult?.statistics.feedRateRange) {
      const { min, max } = lastResult.statistics.feedRateRange;
      legend.textContent = `Feed rate range: ${min.toFixed(0)}–${max.toFixed(0)} mm/min (blue = slowest, red = fastest)`;
      legend.hidden = false;
    } else {
      legend.hidden = true;
    }
  }

  toggleExtrusionButton.addEventListener("click", () => {
    showExtrusion = !showExtrusion;
    toggleExtrusionButton.setAttribute("aria-pressed", String(showExtrusion));
    rebuildVisibleGeometry();
  });
  toggleTravelButton.addEventListener("click", () => {
    showTravel = !showTravel;
    toggleTravelButton.setAttribute("aria-pressed", String(showTravel));
    rebuildVisibleGeometry();
  });
  toggleRetractButton.addEventListener("click", () => {
    showRetractMarkers = !showRetractMarkers;
    toggleRetractButton.setAttribute("aria-pressed", String(showRetractMarkers));
    rebuildVisibleGeometry();
  });

  opacityInput.addEventListener("input", () => {
    const opacity = Number(opacityInput.value) || 1;
    for (const obj of lineSegments) (obj.material as InstanceType<ThreeModule["LineBasicMaterial"]>).opacity = opacity;
    viewport?.requestRender();
  });

  gridButton.addEventListener("click", () => {
    const visible = gridButton.getAttribute("aria-pressed") !== "true";
    gridButton.setAttribute("aria-pressed", String(visible));
    if (visible && THREE && viewport && !gridHelper) {
      gridHelper = new THREE.GridHelper(200, 20);
      viewport.scene.add(gridHelper);
    }
    if (gridHelper) gridHelper.visible = visible;
    viewport?.requestRender();
  });
  axesButton.addEventListener("click", () => {
    const visible = axesButton.getAttribute("aria-pressed") !== "true";
    axesButton.setAttribute("aria-pressed", String(visible));
    if (visible && THREE && viewport && !axesHelper) {
      axesHelper = new THREE.AxesHelper(50);
      viewport.scene.add(axesHelper);
    }
    if (axesHelper) axesHelper.visible = visible;
    viewport?.requestRender();
  });
  backgroundSelect.addEventListener("change", () => {
    viewportContainer.dataset.background = backgroundSelect.value;
  });
  screenshotButton.addEventListener("click", () => void exportScreenshot());
  downloadReportButton.addEventListener("click", downloadReport);
  clearButton.addEventListener("click", clearFile);

  // Layer controls
  function setLayerMode(mode: LayerViewMode): void {
    layerViewMode = mode;
    layerModeSingleButton.setAttribute("aria-pressed", String(mode === "single"));
    layerModeCumulativeButton.setAttribute("aria-pressed", String(mode === "cumulative"));
    layerModeAllButton.setAttribute("aria-pressed", String(mode === "all"));
    rebuildVisibleGeometry();
  }
  layerModeSingleButton.addEventListener("click", () => setLayerMode("single"));
  layerModeCumulativeButton.addEventListener("click", () => setLayerMode("cumulative"));
  layerModeAllButton.addEventListener("click", () => setLayerMode("all"));
  layerScrubInput.addEventListener("input", () => {
    currentLayer = Number(layerScrubInput.value);
    layerRangeEnd = currentLayer;
    currentLayerLabel.textContent = String(currentLayer + 1);
    rebuildVisibleGeometry();
  });

  // Playback controls
  playPauseButton.addEventListener("click", () => {
    if (playback.status === "playing") {
      playback = playbackPause(playback);
      stopPlaybackLoop();
    } else if (playback.status === "paused") {
      playback = playbackResume(playback);
      startPlaybackLoop();
    } else {
      playback = playbackPlay(playback);
      startPlaybackLoop();
    }
    updatePlaybackUi();
  });
  restartButton.addEventListener("click", () => {
    playback = playbackRestart(playback);
    stopPlaybackLoop();
    updatePlaybackUi();
  });
  stepForwardButton.addEventListener("click", () => {
    playback = playbackStepForward(playback);
    updatePlaybackUi();
  });
  stepBackButton.addEventListener("click", () => {
    playback = playbackStepBackward(playback);
    updatePlaybackUi();
  });
  progressScrub.addEventListener("input", () => {
    playback = playbackSeek(playback, Number(progressScrub.value));
    updatePlaybackUi();
  });
  playbackRateSelect.addEventListener("change", () => {
    playback = playbackSetRate(playback, Number(playbackRateSelect.value));
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
    await initWorker();
  }

  void boot();
}

if (typeof document !== "undefined") {
  init();
}
