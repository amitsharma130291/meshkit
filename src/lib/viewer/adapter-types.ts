/**
 * The universal viewer's adapter contract. An adapter is a thin bridge
 * between one existing, already-tested worker pipeline (`obj-viewer.worker.ts`,
 * `glb-viewer.worker.ts`, ...) and the shared `/viewer/` shell — it never
 * parses a file itself. Six adapters (`src/lib/viewer/adapters/*.ts`) each
 * own their own module-scoped Three.js scene state, exactly like a
 * dedicated viewer page's `_client.ts` does, so `buildScene`/
 * `applyDisplayOptions`/`disposeScene` need no explicit "handle" object
 * threaded through the universal client — an adapter module IS its own
 * handle, the same way each dedicated page's top-level `let` variables
 * already are.
 *
 * The shared viewport (canvas, renderer, camera, lights, resize
 * observer, `OrbitControls`) is owned by `src/pages/viewer/_client.ts`
 * itself, never rebuilt per adapter — only an adapter's own geometry/
 * material/texture content is added to and removed from that one shared
 * `THREE.Scene`.
 */
import type { WorkerLike } from "../workers/worker-client";
import type { SafeError } from "../errors";
import type { DetectedFormat } from "./format-detection";

export interface UniversalInfoField {
  label: string;
  value: string;
}

/** One row in the shared segment/hierarchy panel — an adapter maps its own concept (OBJ object/group, 3MF build instance, GLB node/primitive, PLY render category, FBX mesh instance) into this one shape. `key` must be stable across a single load so visibility toggles survive a re-render of the panel. */
export interface AdapterSegmentRow {
  key: string;
  groupLabel: string;
  rowLabel: string;
  countLabel: string;
  visible: boolean;
}

export interface AdapterMaterialCard {
  name: string;
  colorHex: string;
  meta: string;
}

export type AdapterColorMode = "original" | "neutral" | "vertex-colors";

export interface AdapterCapabilities {
  wireframe: boolean;
  shading: boolean;
  colorModes: AdapterColorMode[];
  segments: boolean;
  materials: boolean;
  /** Per declared-unit note — e.g. "model units", "mm (declared)", "m (normalized)". Purely for the shared shell's unit-note copy; never invented when an adapter's own format has no such concept. */
  unitNote: string;
}

export interface AdapterDisplayOptions {
  wireframe: boolean;
  shadingMode: "source" | "flat";
  colorMode: AdapterColorMode;
  modelColorHex: string;
  hiddenSegmentKeys: ReadonlySet<string>;
}

export interface AdapterFitTarget {
  radius: number;
  center: [number, number, number];
}

export interface AdapterContext {
  THREE: typeof import("three");
  scene: import("three").Scene;
  requestRender: () => void;
  /** Only used by adapters with embedded-texture support (GLB, FBX) — mirrors the "worker extracts bytes, main thread decodes" split those two viewers already use. */
  onContextLost?: (error: SafeError) => void;
}

/**
 * `TResult` is the adapter's own worker result type (`STLParseResult`,
 * `OBJViewerResult`, ...) — never re-typed as `unknown`, so each adapter
 * file gets full type safety against the exact same result shape its
 * dedicated viewer page already uses.
 */
export interface ViewerAdapter<TResult = unknown> {
  format: DetectedFormat;
  label: string;
  extensions: string[];
  /** Lazily constructs the exact same Worker this format's own dedicated page uses — never a re-implementation. */
  createWorker(): WorkerLike;
  capabilities(result: TResult): AdapterCapabilities;
  /** Builds this format's geometry/materials into `ctx.scene` and applies `options`. Disposes any previous content first — safe to call more than once without an intervening `disposeScene()`. */
  buildScene(ctx: AdapterContext, result: TResult, options: AdapterDisplayOptions): Promise<void>;
  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void;
  disposeScene(ctx: AdapterContext): void;
  fitAllTarget(result: TResult): AdapterFitTarget;
  /** `null` when every segment is hidden (or the format has none) — the universal client falls back to `fitAllTarget` in that case. */
  fitVisibleTarget(result: TResult, hiddenSegmentKeys: ReadonlySet<string>): AdapterFitTarget | null;
  /** Format-specific fields only — filename/size/detected-format are added by the shared shell itself, never duplicated here. */
  info(result: TResult): UniversalInfoField[];
  dimensions(result: TResult): { width: string; height: string; depth: string };
  unsupportedFeaturesNote(result: TResult): string | null;
  warnings(result: TResult): { message: string }[];
  segments(result: TResult): AdapterSegmentRow[] | null;
  materials(result: TResult): AdapterMaterialCard[] | null;
}

export interface ViewerAdapterModule<TResult = unknown> {
  default: ViewerAdapter<TResult>;
}
