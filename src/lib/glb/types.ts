import type { STLBounds } from "../stl/types";

/** Column-major 4x4 matrix, 16 numbers — glTF's own convention (and, conveniently, three.js's `Matrix4.elements` layout too). Element `[col*4+row]`. */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// --- Raw (but type-checked) glTF JSON shape -------------------------------
// Deliberately minimal: only the fields this converter's geometry path
// actually reads are modeled precisely. Fields used only to decide whether
// to show a "not preserved" warning (materials, animations, skins, morph
// targets) are read as loose optional arrays/flags — this converter never
// interprets their content, only whether they're present.

export interface GLTFAsset {
  version: string;
}

export interface GLTFScene {
  nodes: number[];
  name?: string;
}

export interface GLTFNode {
  children: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  name?: string;
}

export interface GLTFPrimitiveAttributes {
  POSITION?: number;
  [attribute: string]: number | undefined;
}

export interface GLTFPrimitive {
  attributes: GLTFPrimitiveAttributes;
  indices?: number;
  material?: number;
  mode: number;
  targets?: Record<string, number>[];
  extensions?: Record<string, unknown>;
}

export interface GLTFMesh {
  primitives: GLTFPrimitive[];
  name?: string;
}

export interface GLTFSparseIndices {
  bufferView: number;
  byteOffset: number;
  componentType: number;
}

export interface GLTFSparseValues {
  bufferView: number;
  byteOffset: number;
}

export interface GLTFSparse {
  count: number;
  indices: GLTFSparseIndices;
  values: GLTFSparseValues;
}

export interface GLTFAccessor {
  bufferView?: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: GLTFSparse;
}

export interface GLTFBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  byteStride?: number;
  extensions?: Record<string, unknown>;
}

export interface GLTFBuffer {
  byteLength: number;
  uri?: string;
}

export interface GLTFDocument {
  asset: GLTFAsset;
  scene?: number;
  scenes: GLTFScene[];
  nodes: GLTFNode[];
  meshes: GLTFMesh[];
  accessors: GLTFAccessor[];
  bufferViews: GLTFBufferView[];
  buffers: GLTFBuffer[];
  extensionsRequired: string[];
  extensionsUsed: string[];
  /** Presence/length only — content is never parsed by this converter. */
  materialsUsed: boolean;
  animationCount: number;
  skinCount: number;
}

// --- Decoded, pre-transform geometry ---------------------------------------

export interface DecodedPrimitive {
  /** Flat [x,y,z, x,y,z, ...] in the primitive's own local (untransformed, unconverted) space. */
  positions: Float32Array;
  /** Flat [v1,v2,v3, ...] triangle vertex indices into `positions`, already resolved from whatever primitive mode produced them. */
  triangleIndices: Uint32Array;
  hasMaterial: boolean;
  hasTexCoords: boolean;
  hasVertexColors: boolean;
  hasMorphTargets: boolean;
}

export interface DecodedMesh {
  primitives: DecodedPrimitive[];
}

// --- Conversion result -------------------------------------------------

export type ConversionWarningCode =
  | "materials-not-preserved"
  | "textures-not-preserved"
  | "vertex-colors-not-preserved"
  | "animations-not-preserved"
  | "skins-not-preserved"
  | "morph-targets-not-preserved"
  | "unsupported-primitives-skipped"
  | "degenerate-triangles-skipped";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

export interface ResolvedGLBScene {
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  sourceVertexCount: number;
  meshCount: number;
  primitiveCount: number;
  nodeInstanceCount: number;
  sceneName?: string;
  skippedDegenerateTriangles: number;
  skippedUnsupportedPrimitives: number;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface GLBToSTLResult extends ResolvedGLBScene {
  stlBuffer: ArrayBuffer;
  sourceUnits: "meter";
  outputScale: "millimeter";
  scaleFactor: 1000;
}

export interface GLBLimits {
  maxContainerBytes: number;
  maxJsonBytes: number;
  maxBinBytes: number;
  maxScenes: number;
  maxNodes: number;
  maxMeshes: number;
  maxPrimitivesPerMesh: number;
  maxBuffers: number;
  maxBufferViews: number;
  maxAccessors: number;
  /** Per-accessor element-count ceiling, checked before allocating that accessor's decode buffer. */
  maxAccessorElements: number;
  maxTotalVertices: number;
  maxTriangles: number;
  maxSceneDepth: number;
  maxSceneInstances: number;
  /** Validated against the STL serializer's computed output size before allocating it. */
  maxStlBytes: number;
}

export const DEFAULT_GLB_LIMITS: GLBLimits = {
  maxContainerBytes: 150 * 1024 * 1024,
  maxJsonBytes: 32 * 1024 * 1024,
  maxBinBytes: 150 * 1024 * 1024,
  maxScenes: 1000,
  maxNodes: 200_000,
  maxMeshes: 50_000,
  maxPrimitivesPerMesh: 256,
  maxBuffers: 100,
  maxBufferViews: 100_000,
  maxAccessors: 100_000,
  maxAccessorElements: 10_000_000,
  maxTotalVertices: 10_000_000,
  maxTriangles: 3_000_000,
  maxSceneDepth: 64,
  maxSceneInstances: 200_000,
  maxStlBytes: 400 * 1024 * 1024,
};

/** glTF's metre-based coordinates are scaled by exactly this factor, exactly once, to produce millimetre-scaled STL output. */
export const METERS_TO_MILLIMETERS = 1000;
