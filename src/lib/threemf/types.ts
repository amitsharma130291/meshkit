import type { STLBounds } from "../stl/types";

export type ThreeMFUnit = "micron" | "millimeter" | "centimeter" | "inch" | "foot" | "meter";

/** Per the 3MF core spec, "millimeter" is the default when a model declares no unit. */
export const DEFAULT_THREEMF_UNIT: ThreeMFUnit = "millimeter";

/** 3x4 affine transform: 3 rows of [scale/rotation..., translation] in the 3MF attribute's column-major-per-row layout — see transforms.ts. */
export type ThreeMFTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_TRANSFORM: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export interface ThreeMFMeshObject {
  kind: "mesh";
  id: string;
  /** Flat [x,y,z, x,y,z, ...] in the object's own local (unconverted, untransformed) units. */
  vertices: Float64Array;
  /** Flat [v1,v2,v3, ...] indices into `vertices`. */
  triangleIndices: Uint32Array;
}

export interface ThreeMFComponentRef {
  objectId: string;
  transform: ThreeMFTransform;
}

export interface ThreeMFComponentsObject {
  kind: "components";
  id: string;
  components: ThreeMFComponentRef[];
}

export type ThreeMFObject = ThreeMFMeshObject | ThreeMFComponentsObject;

export interface ThreeMFBuildItem {
  objectId: string;
  transform: ThreeMFTransform;
}

/** Raw, unresolved model document — one <model> element's worth of parsed data. */
export interface ThreeMFModel {
  unit: ThreeMFUnit;
  objects: Map<string, ThreeMFObject>;
  buildItems: ThreeMFBuildItem[];
  /** Local names of resource elements encountered that this converter doesn't support (materials, colors, textures, ...). */
  unsupportedFeatures: Set<string>;
}

export type ConversionWarningCode = "colors-not-preserved" | "materials-not-preserved" | "textures-not-preserved" | "metadata-not-preserved";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

/** The flattened, unit-converted, millimeter-scale scene ready for STL serialization/preview. */
export interface ResolvedScene {
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  objectCount: number;
  buildItemCount: number;
  componentInstanceCount: number;
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface ThreeMFToSTLResult {
  positions: Float32Array;
  normals: Float32Array;
  stlBuffer: ArrayBuffer;
  triangleCount: number;
  objectCount: number;
  buildItemCount: number;
  componentInstanceCount: number;
  sourceUnit: ThreeMFUnit;
  outputScale: "millimeter";
  bounds: STLBounds;
  warnings: ConversionWarning[];
}

export interface ThreeMFLimits {
  /** ZIP container safety limits. */
  maxCompressedPackageBytes: number;
  maxZipEntries: number;
  maxSingleEntryDecompressedBytes: number;
  maxTotalDecompressedBytes: number;
  /** decompressed / compressed, per entry. A legitimate 3MF model XML rarely exceeds ~30:1. */
  maxCompressionRatio: number;
  /** Scene safety limits. */
  maxModelXmlBytes: number;
  maxTriangles: number;
  maxComponentInstances: number;
  maxComponentDepth: number;
}

export const DEFAULT_THREEMF_LIMITS: ThreeMFLimits = {
  maxCompressedPackageBytes: 150 * 1024 * 1024,
  maxZipEntries: 2000,
  maxSingleEntryDecompressedBytes: 300 * 1024 * 1024,
  maxTotalDecompressedBytes: 400 * 1024 * 1024,
  maxCompressionRatio: 300,
  maxModelXmlBytes: 200 * 1024 * 1024,
  maxTriangles: 3_000_000,
  maxComponentInstances: 200_000,
  maxComponentDepth: 32,
};
