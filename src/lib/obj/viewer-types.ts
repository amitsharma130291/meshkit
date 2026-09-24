import type { STLBounds } from "../stl/types";
import { DEFAULT_OBJ_LIMITS, type OBJLimits } from "./types";

/**
 * Viewer-only warning vocabulary. Distinct from `ConversionWarningCode`
 * (types.ts) because the viewer's story is different from the converter's:
 * the converter warns about what STL *drops*, while the viewer warns about
 * what it *can't render* even though it kept parsing the data (e.g. a
 * referenced material name is shown in the scene tree, but never fetched
 * or rendered as an actual material).
 */
export type OBJViewerWarningCode =
  | "materials-not-rendered"
  | "textures-not-rendered"
  | "vertex-colors-not-rendered"
  | "zero-length-normal"
  | "non-planar-faces";

export interface OBJViewerWarning {
  code: OBJViewerWarningCode;
  message: string;
}

/**
 * A maximal contiguous run of triangles sharing the same object, group
 * membership, material reference and smoothing group — i.e. a new segment
 * starts only when one of those four attributes actually changes,
 * following source order. `bounds` covers only this segment's own
 * triangles, so "fit visible" can union just the visible segments' boxes
 * instead of recomputing from scratch.
 */
export interface OBJViewerSegment {
  objectName: string;
  groupNames: string[];
  materialName: string | null;
  /** `null` when smoothing is off/unset for this segment. */
  smoothingGroup: number | null;
  triangleStart: number;
  triangleCount: number;
  bounds: STLBounds;
}

/** The flattened, triangulated geometry plus scene metadata a viewer needs that a converter (buildOBJGeometry) intentionally discards. */
export interface OBJViewerResult {
  positions: Float32Array;
  /** Smooth/source normals: a valid, normalized `vn` per corner where present, geometric fallback elsewhere. */
  normals: Float32Array;
  /** Always geometric — one normal per triangle, replicated across its three corners. */
  flatNormals: Float32Array;
  /** False when no face corner in the whole file had a valid, non-zero source normal — the UI should disable the source/smooth shading option and default to flat. */
  hasValidSourceNormals: boolean;
  triangleCount: number;
  sourceVertexCount: number;
  sourceNormalCount: number;
  sourceTextureCoordinateCount: number;
  sourceFaceCount: number;
  objectCount: number;
  groupCount: number;
  materialLibraryCount: number;
  usedMaterialCount: number;
  /** Bounded, sanitized list of distinct material names actually referenced by `usemtl` — for scene-tree display, never fetched. */
  usedMaterialNames: string[];
  hasTextureCoordinates: boolean;
  lineCount: number;
  pointCount: number;
  bounds: STLBounds;
  segments: OBJViewerSegment[];
  /** Flat [x0,y0,z0, x1,y1,z1, ...] vertex pairs — two entries (6 floats) per rendered line segment. Present only when the file has at least one renderable line. */
  lineGeometry?: Float32Array;
  /** Flat [x,y,z, ...] — one entry (3 floats) per rendered point. Present only when the file has at least one renderable point. */
  pointGeometry?: Float32Array;
  warnings: OBJViewerWarning[];
}

export interface OBJViewerLimits extends OBJLimits {
  /** Hard ceiling on the number of object/group/material/smoothing-group boundary transitions — protects the scene tree and per-segment bookkeeping from an adversarial file that changes state every face. */
  maxSegments: number;
  /** Characters kept from any displayed name (object, group, material) before truncating with an ellipsis. */
  maxNameLength: number;
  /** Simultaneous group memberships accepted from a single `g a b c ...` statement; extra names on the same statement are ignored. */
  maxGroupNamesPerStatement: number;
  /** Rendered line segments, after expanding every `l` statement's polyline into consecutive pairs. */
  maxLineSegments: number;
  /** Rendered points, after expanding every `p` statement's reference list. */
  maxPoints: number;
  /** Distinct material names retained for scene-tree display. */
  maxUsedMaterialNames: number;
  /** Total bytes across every retained name string (object/group/material) — a backstop behind the per-name and per-segment ceilings above. */
  maxMetadataBytes: number;
}

export const DEFAULT_OBJ_VIEWER_LIMITS: OBJViewerLimits = {
  ...DEFAULT_OBJ_LIMITS,
  maxSegments: 1000,
  maxNameLength: 80,
  maxGroupNamesPerStatement: 16,
  maxLineSegments: 500_000,
  maxPoints: 500_000,
  maxUsedMaterialNames: 200,
  maxMetadataBytes: 4 * 1024 * 1024,
};
