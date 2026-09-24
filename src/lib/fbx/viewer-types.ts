import type { STLBounds } from "../stl/types";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";

/**
 * One resolved Model + attached Geometry visit — analogous to a GLB
 * "segment" (node/mesh/primitive visit), but FBX's own vertex layout is
 * per-corner and non-indexed (closer to OBJ's own convention than GLB's
 * indexed one, since FBX layer elements are themselves fundamentally
 * per-corner/per-polygon data): `indexStart`/`indexCount` are corner
 * offsets into the shared `indices` array, which starts as a plain
 * identity ordering and is only ever re-sliced client-side for
 * visibility toggling — never rebuilt from a deduplicated vertex set.
 */
export interface FBXViewerSegment {
  modelName: string | null;
  /** Ancestor Model segment indices from a hierarchy root down to (excluding) this one. */
  modelPath: number[];
  materialIndex: number | null;
  indexStart: number;
  indexCount: number;
  bounds: STLBounds;
}

export interface FBXViewerMaterial {
  name: string | null;
  shadingModel: string;
  diffuseColor: [number, number, number];
  diffuseFactor: number;
  opacity: number;
  /** A connected Texture resolves to embedded, still-encoded image bytes — see `images`. */
  embeddedImageIndex: number | null;
  /** A connected Texture exists but has no usable embedded bytes (external-only, or an unsupported embedded format). */
  hasExternalOrUnsupportedTexture: boolean;
}

export interface FBXViewerImage {
  mimeType: "image/png" | "image/jpeg";
  /** Raw, still-encoded image bytes — decoded on the main thread, never in this worker (see docs/ARCHITECTURE.md). */
  bytes: Uint8Array;
}

export type FBXUnsupportedFeature =
  | "animation"
  | "skinning"
  | "skeleton"
  | "blend-shapes"
  | "cameras"
  | "lights"
  | "nurbs-or-patch-geometry"
  | "subdivision-surfaces"
  | "constraints"
  | "layered-textures";

export type FBXViewerWarningCode =
  | "layer-element-unsupported-mapping"
  | "layer-element-unsupported-reference"
  | "layer-element-invalid-index"
  | "geometric-fallback-normals"
  | "additional-uv-sets-not-rendered"
  | "unsupported-inherit-type"
  | "unsupported-rotation-order"
  | "multiple-structural-parents"
  | "degenerate-polygons-skipped"
  | "unsupported-embedded-image-format"
  | "external-texture-not-fetched"
  | "unrecognized-object-types"
  | "material-reference-invalid"
  | "axis-system-unknown"
  | "unit-scale-unknown";

export interface FBXViewerWarning {
  code: FBXViewerWarningCode;
  message: string;
}

/** The flattened, resolved viewer scene. Coordinates are normalized once into a right-handed, Y-up system and (when the file declares a usable `UnitScaleFactor`) into meters — never per-node, always as a single combined global transform. */
export interface FBXViewerResult {
  /** Per-corner, flat [x,y,z, ...] — normalized (axis + unit), post every Model/Geometric transform. */
  positions: Float32Array;
  /** Per-corner, flat [x,y,z, ...] smooth: source LayerElementNormal where valid, else an averaged geometric fallback, both correctly transformed by the inverse-transpose normal matrix. */
  normals: Float32Array;
  /** Per-corner UV from the file's first usable LayerElementUV, present only when at least one geometry has one. */
  uvs?: Float32Array;
  /** Per-corner linear RGBA from LayerElementColor, present only when at least one geometry has one. */
  colors?: Float32Array;
  /** Identity-ordered corner indices into the buffers above — never deduplicated, only ever re-sliced client-side per visible segment. */
  indices: Uint32Array;
  segments: FBXViewerSegment[];
  materials: FBXViewerMaterial[];
  images: (FBXViewerImage | null)[];
  boundsModelUnits: STLBounds;

  fbxVersion: number;
  encoding: "binary";
  recordLayout: "32-bit" | "64-bit";
  creator: string | null;
  modelCount: number;
  geometryCount: number;
  meshInstanceCount: number;
  materialCount: number;
  embeddedTextureCount: number;
  externalTextureReferenceCount: number;
  controlPointCount: number;
  polygonCount: number;
  renderedTriangleCount: number;
  skippedPolygonCount: number;
  hasSourceNormals: boolean;
  hasUVs: boolean;
  hasVertexColors: boolean;

  /** Centimeters per scene unit, as declared — `null` when missing/invalid (coordinates then stay in raw model units, unscaled). */
  sourceUnitScaleFactor: number | null;
  normalizedToMeters: boolean;
  axisSystemKnown: boolean;

  unsupportedFeatures: FBXUnsupportedFeature[];
  unrecognizedObjectClassCount: number;
  warnings: FBXViewerWarning[];
}

export interface FBXViewerLimits extends FBXLimits {
  maxSegments: number;
  maxNameLength: number;
}

export const DEFAULT_FBX_VIEWER_LIMITS: FBXViewerLimits = {
  ...DEFAULT_FBX_LIMITS,
  maxSegments: 20_000,
  maxNameLength: 80,
};
