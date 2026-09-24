import type { STLBounds } from "../stl/types";
import { DEFAULT_PLY_LIMITS, type PLYFormat, type PLYLimits } from "./types";

export type PLYRenderCategory = "surface" | "edges" | "points";

export type PLYViewerWarningCode = "invalid-normal-fallback" | "invalid-color-clamped" | "unrecognized-edge-layout" | "non-planar-faces";

export interface PLYViewerWarning {
  code: PLYViewerWarningCode;
  message: string;
}

/**
 * The flattened viewer scene. Unlike OBJ/3MF/GLB, PLY has no scene graph
 * and no per-instance transforms — every vertex lives in exactly one
 * shared, untransformed array, and surfaces/edges/points are just
 * different *index* views into that same array (triangulated face
 * indices, edge vertex-pairs, or "every vertex" respectively). This is
 * what makes bounds trivial here compared to the other three viewers:
 * there's no combined-bounds bug class to guard against when every
 * category already draws from the same position buffer — see
 * `boundsSurface`/`boundsEdges`/`boundsPoints` below for the one place
 * category-specific bounds still matter (fit-visible with some
 * categories hidden).
 */
export interface PLYViewerResult {
  /** Per-vertex, model units — PLY defines no measurement unit, so coordinates are preserved exactly, never scaled. */
  positions: Float32Array;
  /** Per-vertex smooth normals (source-valid-or-averaged-fallback) — present only when the file has a renderable surface; never fabricated for a point-only file. */
  normals?: Float32Array;
  /** Per-vertex linear RGBA, 0..1 — present only when the vertex element declares a recognized color property. */
  colors?: Float32Array;
  /** Per-vertex UV — present only when a recognized texture-coordinate pair is declared. Metadata only; never used to sample a texture (PLY has none). */
  uvs?: Float32Array;
  /** Triangle indices into `positions` — present only when the file has a `face` element that triangulated successfully. */
  surfaceIndices?: Uint32Array;
  /** Vertex-index pairs into `positions` — present only when the file has a recognized `edge` element. */
  edgeIndices?: Uint32Array;

  format: PLYFormat;
  sourceVertexCount: number;
  sourceFaceCount: number;
  renderedTriangleCount: number;
  edgeCount: number;
  /** Always equals `sourceVertexCount` when greater than 0 — every vertex is renderable as a point, regardless of whether it's also used by a face or edge. */
  renderedPointCount: number;
  vertexPropertyCount: number;
  facePropertyCount: number;
  unknownElementCount: number;
  unknownPropertyCount: number;
  commentCount: number;
  objInfoCount: number;
  hasSourceNormals: boolean;
  hasVertexColors: boolean;
  hasAlpha: boolean;
  hasTextureCoordinates: boolean;
  boundsModelUnits: STLBounds;
  boundsSurface?: STLBounds;
  boundsEdges?: STLBounds;
  boundsPoints?: STLBounds;
  warnings: PLYViewerWarning[];
}

export interface PLYViewerLimits extends PLYLimits {
  maxEdgeCount: number;
  maxPointCount: number;
}

export const DEFAULT_PLY_VIEWER_LIMITS: PLYViewerLimits = {
  ...DEFAULT_PLY_LIMITS,
  maxEdgeCount: 2_000_000,
  maxPointCount: 5_000_000,
};
