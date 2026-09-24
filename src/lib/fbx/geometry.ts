/**
 * Decodes one `Geometry` object's mesh data — `Vertices` (flat control
 * points) and `PolygonVertexIndex` (FBX's own polygon-vertex stream,
 * where a negative entry marks a polygon's final corner via
 * `-index - 1`) — into control points plus triangulated, index-tracked
 * corners. Triangulation itself is not reimplemented here: every polygon
 * with 4+ vertices goes through the exact same
 * `triangulatePolygon()` (`src/lib/mesh/triangulate.ts`) OBJ and PLY
 * already use, so concave polygons are handled identically across every
 * format this project reads.
 *
 * A genuinely malformed stream (an out-of-range control-point reference,
 * a polygon with fewer than three corners, an index stream that doesn't
 * end on a polygon terminator) is a hard, file-level error — the same
 * treatment OBJ/PLY give it. A polygon `triangulatePolygon()` itself
 * rejects as degenerate, non-planar or self-intersecting is different:
 * this is a common, real-world authoring/export artifact (decimation,
 * float rounding), so — matching the skip-and-count precedent
 * `resolveGLBScene()` already established for post-transform degenerate
 * *triangles* — it's skipped and counted here, never silently dropped
 * without a trace and never failing the whole file over one bad polygon.
 */
import { FaceTooSmallError, PolygonDegenerateError, PolygonNonPlanarError, PolygonSelfIntersectingError, TriangulationFailedError } from "../mesh/errors";
import { triangulatePolygon } from "../mesh/triangulate";
import { findChild } from "./document";
import { fbxError } from "./errors";
import type { FBXNode, FBXLimits } from "./types";

export interface FBXTriangleRef {
  /** Control-point indices for this triangle's 3 corners — used to fetch positions. */
  controlPointIndices: [number, number, number];
  /** Original flat corner indices (into `cornerControlPointIndices`/layer-element arrays) for this triangle's 3 corners — used for `ByPolygonVertex` layer-element lookups, which must reference the *source* corner, not a post-triangulation one. */
  cornerIndices: [number, number, number];
  polygonIndex: number;
}

export interface FBXDecodedGeometry {
  /** Flat [x,y,z, ...] control points, in the geometry's own local (untransformed) space. */
  controlPoints: Float64Array;
  controlPointCount: number;
  /** Flat corner→control-point-index stream, terminators already resolved to plain non-negative indices. */
  cornerControlPointIndices: Int32Array;
  polygonVertexCounts: Int32Array;
  polygonCornerStarts: Int32Array;
  polygonCount: number;
  triangles: FBXTriangleRef[];
  skippedDegeneratePolygons: number;
  hasNonPlanarPolygons: boolean;
}

function isTriangulationSkip(error: unknown): boolean {
  return (
    error instanceof FaceTooSmallError ||
    error instanceof PolygonDegenerateError ||
    error instanceof PolygonNonPlanarError ||
    error instanceof PolygonSelfIntersectingError ||
    error instanceof TriangulationFailedError
  );
}

export function decodeFBXGeometry(node: FBXNode, limits: FBXLimits): FBXDecodedGeometry {
  const verticesNode = findChild(node, "Vertices");
  const indexNode = findChild(node, "PolygonVertexIndex");
  if (!verticesNode || !indexNode) throw fbxError("FBX_GEOMETRY_INVALID");

  const verticesProp = verticesNode.properties[0];
  if (!verticesProp || verticesProp.type !== "d") throw fbxError("FBX_GEOMETRY_INVALID");
  const controlPoints = verticesProp.value;
  if (controlPoints.length % 3 !== 0) throw fbxError("FBX_GEOMETRY_INVALID");
  const controlPointCount = controlPoints.length / 3;
  if (controlPointCount > limits.maxControlPointsPerGeometry) throw fbxError("FBX_CONTROL_POINT_LIMIT_EXCEEDED");
  for (let i = 0; i < controlPoints.length; i++) {
    if (!Number.isFinite(controlPoints[i])) throw fbxError("FBX_NON_FINITE_VERTEX");
  }

  const indexProp = indexNode.properties[0];
  if (!indexProp || indexProp.type !== "i") throw fbxError("FBX_GEOMETRY_INVALID");
  const rawIndices = indexProp.value;

  const cornerControlPointIndices: number[] = [];
  const polygonVertexCounts: number[] = [];
  const polygonCornerStarts: number[] = [];
  let currentPolygonStart = 0;
  let polygonCount = 0;

  for (let i = 0; i < rawIndices.length; i++) {
    const raw = rawIndices[i];
    const isLastOfPolygon = raw < 0;
    const cpIndex = isLastOfPolygon ? -raw - 1 : raw;
    if (cpIndex < 0 || cpIndex >= controlPointCount) throw fbxError("FBX_POLYGON_INDEX_OUT_OF_RANGE");
    cornerControlPointIndices.push(cpIndex);

    if (isLastOfPolygon) {
      const count = cornerControlPointIndices.length - currentPolygonStart;
      if (count < 3) throw fbxError("FBX_POLYGON_TOO_SMALL");
      if (count > limits.maxPolygonVertexCount) throw fbxError("FBX_POLYGON_VERTEX_LIMIT_EXCEEDED");
      polygonCornerStarts.push(currentPolygonStart);
      polygonVertexCounts.push(count);
      polygonCount++;
      if (polygonCount > limits.maxPolygonsPerGeometry) throw fbxError("FBX_POLYGON_COUNT_EXCEEDED");
      currentPolygonStart = cornerControlPointIndices.length;
    }
  }
  if (currentPolygonStart !== cornerControlPointIndices.length) {
    throw fbxError("FBX_GEOMETRY_INVALID"); // stream didn't end on a polygon terminator
  }

  const triangles: FBXTriangleRef[] = [];
  let skippedDegeneratePolygons = 0;
  let hasNonPlanarPolygons = false;

  for (let p = 0; p < polygonCount; p++) {
    const start = polygonCornerStarts[p];
    const count = polygonVertexCounts[p];
    const localPositions: [number, number, number][] = [];
    for (let c = 0; c < count; c++) {
      const cpIndex = cornerControlPointIndices[start + c];
      localPositions.push([controlPoints[cpIndex * 3], controlPoints[cpIndex * 3 + 1], controlPoints[cpIndex * 3 + 2]]);
    }

    let localTriangles: [number, number, number][];
    try {
      const result = triangulatePolygon(localPositions, 10_000);
      localTriangles = result.triangles;
      if (result.nonPlanarWarning) hasNonPlanarPolygons = true;
    } catch (error) {
      if (isTriangulationSkip(error)) {
        skippedDegeneratePolygons++;
        continue;
      }
      throw error;
    }

    for (const [a, b, c] of localTriangles) {
      if (triangles.length >= limits.maxTriangles) throw fbxError("FBX_TRIANGLE_LIMIT_EXCEEDED");
      triangles.push({
        controlPointIndices: [cornerControlPointIndices[start + a], cornerControlPointIndices[start + b], cornerControlPointIndices[start + c]],
        cornerIndices: [start + a, start + b, start + c],
        polygonIndex: p,
      });
    }
  }

  return {
    controlPoints,
    controlPointCount,
    cornerControlPointIndices: Int32Array.from(cornerControlPointIndices),
    polygonVertexCounts: Int32Array.from(polygonVertexCounts),
    polygonCornerStarts: Int32Array.from(polygonCornerStarts),
    polygonCount,
    triangles,
    skippedDegeneratePolygons,
    hasNonPlanarPolygons,
  };
}
