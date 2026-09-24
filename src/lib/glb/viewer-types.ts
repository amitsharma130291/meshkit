import type { STLBounds } from "../stl/types";
import { DEFAULT_GLB_LIMITS, type GLBLimits } from "./types";

export type GLBRenderCategory = "triangles" | "lines" | "points";

export type GLBAlphaMode = "OPAQUE" | "MASK" | "BLEND";

/**
 * One resolved node/mesh/primitive visit — exactly one per mesh-bearing
 * node instance's own primitive, so a mesh referenced by several nodes (or
 * a mesh with several primitives) always produces several independent
 * segments. `indexStart`/`indexCount` are in units matching
 * `renderCategory`: index entries (3 per triangle) into `indices` for
 * "triangles", line segments into `lineGeometry` for "lines", or points
 * into `pointGeometry` for "points" — see viewer-scene.ts.
 */
export interface GLBViewerSegment {
  sceneIndex: number;
  nodeIndex: number;
  /** Ancestor node indices from a scene root down to (excluding) this node. Bounded by `maxSceneDepth`. */
  nodePath: number[];
  meshIndex: number;
  primitiveIndex: number;
  mode: number;
  renderCategory: GLBRenderCategory;
  materialIndex: number | null;
  indexStart: number;
  indexCount: number;
  /** The node's own `name`, sanitized and length-bounded, when present. */
  displayName: string | null;
  bounds: STLBounds;
}

export interface GLBViewerTextureRef {
  textureIndex: number;
  /** Which `TEXCOORD_n` set this reference wants — only 0 is ever actually sampled; a material wanting anything else has its texture disabled with a warning instead. */
  texCoordSet: number;
}

export interface GLBViewerMaterial {
  name: string | null;
  baseColorFactor: [number, number, number, number];
  baseColorTexture: GLBViewerTextureRef | null;
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  alphaMode: GLBAlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
  /** `KHR_materials_unlit` declared on this material. */
  unlit: boolean;
  /** True when a metallic-roughness/normal/occlusion texture is declared — detected, never decoded (see docs). */
  hasUnsupportedTextureMap: boolean;
  /** True when `baseColorTexture` exists but was disabled (an unsupported `texCoord` set, or `KHR_texture_transform`) — factors still apply, the texture doesn't. */
  baseColorTextureDisabled: boolean;
}

export interface GLBViewerSampler {
  /** glTF wrap enum (10497 REPEAT / 33071 CLAMP_TO_EDGE / 33648 MIRRORED_REPEAT). */
  wrapS: number;
  wrapT: number;
  magFilter: number | null;
  minFilter: number | null;
}

export interface GLBViewerTexture {
  sourceImageIndex: number | null;
  sampler: GLBViewerSampler;
}

export interface GLBViewerImage {
  mimeType: string;
  /** Raw, still-encoded image bytes — decoded on the main thread, never in this worker. */
  bytes: Uint8Array;
}

export type GLBViewerWarningCode =
  | "textures-not-rendered"
  | "texture-transform-not-applied"
  | "unsupported-texcoord-set"
  | "unsupported-image-mime"
  | "animations-not-applied"
  | "skins-not-applied"
  | "morph-targets-not-applied"
  | "degenerate-triangles-skipped"
  | "material-reference-invalid"
  | "texture-reference-invalid";

export interface GLBViewerWarning {
  code: GLBViewerWarningCode;
  message: string;
}

/** The flattened, resolved viewer scene — source glTF metre coordinates, never the GLB→STL converter's ×1000 millimetre scale. */
export interface GLBViewerResult {
  sourceUnit: "meter";
  /** Per-vertex, meters. Global buffer: each segment owns its own contiguous vertex range within it — never deduplicated across segments/primitives. */
  positions: Float32Array;
  /** Per-vertex, smooth: source `NORMAL` where a primitive has one, else averaged from that primitive's own adjacent face normals. */
  normals: Float32Array;
  /** Per-vertex UV, present only when at least one primitive in the file has `TEXCOORD_0` (zero-filled for vertices without). */
  texcoords0?: Float32Array;
  /** Per-vertex linear-space RGBA, present only when at least one primitive has `COLOR_0`. */
  colors0?: Float32Array;
  /** Triangle indices into the shared per-vertex buffers above. */
  indices: Uint32Array;
  /** Flat, non-indexed [x,y,z, ...] vertex pairs — 2 entries (6 floats) per rendered line segment. */
  lineGeometry?: Float32Array;
  lineColors?: Float32Array;
  /** Flat, non-indexed [x,y,z, ...] — 1 entry (3 floats) per rendered point. */
  pointGeometry?: Float32Array;
  pointColors?: Float32Array;
  segments: GLBViewerSegment[];
  materials: GLBViewerMaterial[];
  textures: GLBViewerTexture[];
  /** Same length and order as the source `images` array; `null` for any image that's external (`uri`-based), unsupported, or invalid. */
  images: (GLBViewerImage | null)[];
  boundsMeters: STLBounds;
  gltfVersion: string;
  sceneCount: number;
  nodeCount: number;
  selectedSceneName?: string;
  meshCount: number;
  primitiveCount: number;
  nodeInstanceCount: number;
  sourceVertexCount: number;
  renderedTriangleCount: number;
  renderedLineCount: number;
  renderedPointCount: number;
  skippedDegenerateTriangles: number;
  hasSourceNormals: boolean;
  hasTangents: boolean;
  tangentCount: number;
  hasVertexColors: boolean;
  hasTexCoords: boolean;
  additionalTexCoordSetCount: number;
  animationCount: number;
  skinCount: number;
  morphTargetCount: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  warnings: GLBViewerWarning[];
}

export interface GLBViewerLimits extends GLBLimits {
  /** Resolved node/primitive visits — a stricter viewer-facing ceiling than the shared `maxSceneInstances` package safety limit. */
  maxSegments: number;
  maxNameLength: number;
  maxMaterials: number;
  maxTextures: number;
  maxImages: number;
  /** Per embedded image, before decoding — decoded-pixel ceilings are enforced client-side after `createImageBitmap` reports real dimensions. */
  maxImageBytes: number;
  maxLineSegments: number;
  maxPoints: number;
  maxMetadataBytes: number;
}

export const DEFAULT_GLB_VIEWER_LIMITS: GLBViewerLimits = {
  ...DEFAULT_GLB_LIMITS,
  maxSegments: 20_000,
  maxNameLength: 80,
  maxMaterials: 2000,
  maxTextures: 2000,
  maxImages: 500,
  maxImageBytes: 32 * 1024 * 1024,
  maxLineSegments: 500_000,
  maxPoints: 500_000,
  maxMetadataBytes: 1 * 1024 * 1024,
};
