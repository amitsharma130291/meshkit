import type { STLBounds } from "../stl/types";
import { DEFAULT_THREEMF_LIMITS, type ThreeMFLimits, type ThreeMFUnit } from "./types";

export type ThreeMFViewerWarningCode =
  | "textures-not-rendered"
  | "beam-lattice-not-rendered"
  | "slice-stack-not-rendered"
  | "unsupported-extension-content"
  | "color-reference-invalid"
  | "cross-part-reference-skipped"
  | "alpha-not-rendered";

export interface ThreeMFViewerWarning {
  code: ThreeMFViewerWarningCode;
  message: string;
}

/** A short, deterministic description of a resolved instance's composed transform — never the raw 12-number matrix. */
export type ThreeMFTransformSummary = "identity" | "translated" | "reflected" | "transformed";

/**
 * One resolved mesh-leaf instance — exactly one per visit the build-item →
 * component → ... → mesh-object walk makes, so `segments.length` always
 * equals `resolvedInstanceCount`. This is 3MF's own real hierarchy, not an
 * invented OBJ-style object/group heuristic (see viewer-scene.ts).
 */
export interface ThreeMFViewerSegment {
  buildItemIndex: number;
  meshObjectId: string;
  /** 1-based component-instance indices from the build item down to (excluding) the mesh leaf; empty when the build item references the mesh object directly. Bounded by `maxComponentDepth`. */
  componentPath: number[];
  triangleStart: number;
  triangleCount: number;
  transformSummary: ThreeMFTransformSummary;
  /** The mesh object's own `name` attribute, sanitized and length-bounded, when present. */
  displayName: string | null;
  /** A short, safe label for the object's default color/material resource (e.g. derived from its `pid`/`pindex`), or null when it has none. */
  colorResourceRef: string | null;
  bounds: STLBounds;
}

export interface ThreeMFMetadataEntry {
  name: string;
  value: string;
}

export interface ThreeMFColorResourceSummary {
  baseMaterialGroupCount: number;
  baseMaterialEntryCount: number;
  colorGroupCount: number;
  colorEntryCount: number;
  textureResourceCount: number;
}

/** The flattened, unit-converted-to-millimeters, resolved scene plus everything the viewer needs that `resolveScene()` (the converter's own pipeline) discards. */
export interface ThreeMFViewerResult {
  /** Total entries in the package's ZIP central directory (every part, not just the model). */
  packageEntryCount: number;
  positions: Float32Array;
  normals: Float32Array;
  /** Per-corner RGB, same 9-floats-per-triangle layout as `positions`. Present only when the file has at least one resolvable color/material reference. Values are linear-space (sRGB-decoded), ready for a Three.js `BufferAttribute` with `vertexColors: true`. */
  colors?: Float32Array;
  hasEmbeddedColors: boolean;
  hasTransparentColors: boolean;
  triangleCount: number;
  /** Sum of vertex counts across every declared mesh object (not multiplied by instance count). */
  sourceVertexCount: number;
  /** Declared <object kind="mesh"> count. */
  meshObjectCount: number;
  /** Declared <object kind="components"> count. */
  componentObjectCount: number;
  buildItemCount: number;
  /** Total resolved mesh-leaf visits — equals `segments.length`. */
  resolvedInstanceCount: number;
  declaredUnit: ThreeMFUnit;
  /** Multiply a declared-unit coordinate by this to get millimeters. */
  millimeterScale: number;
  boundsMillimeters: STLBounds;
  segments: ThreeMFViewerSegment[];
  metadata: ThreeMFMetadataEntry[];
  colorResources: ThreeMFColorResourceSummary;
  warnings: ThreeMFViewerWarning[];
}

export interface ThreeMFViewerLimits extends ThreeMFLimits {
  /** Resolved mesh-leaf instances / segments — a stricter viewer-facing ceiling than the shared `maxComponentInstances` package safety limit. */
  maxSegments: number;
  maxNameLength: number;
  maxMetadataEntries: number;
  maxMetadataValueLength: number;
  maxMetadataBytes: number;
  maxMaterialGroups: number;
  maxMaterialEntriesPerGroup: number;
  maxColorGroups: number;
  maxColorEntriesPerGroup: number;
  /** Total rendered color-array bytes (colors.byteLength), checked against the actual triangle-expanded per-corner array. */
  maxColorArrayBytes: number;
}

export const DEFAULT_THREEMF_VIEWER_LIMITS: ThreeMFViewerLimits = {
  ...DEFAULT_THREEMF_LIMITS,
  maxSegments: 20_000,
  maxNameLength: 80,
  maxMetadataEntries: 200,
  maxMetadataValueLength: 2000,
  maxMetadataBytes: 1 * 1024 * 1024,
  maxMaterialGroups: 500,
  maxMaterialEntriesPerGroup: 2000,
  maxColorGroups: 500,
  maxColorEntriesPerGroup: 2000,
  maxColorArrayBytes: 400 * 1024 * 1024,
};
