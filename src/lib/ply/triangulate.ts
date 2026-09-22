/**
 * PLY-specific compatibility wrapper around the canonical, format-neutral
 * triangulator in `src/lib/mesh/triangulate.ts` — the exact same pattern
 * `src/lib/obj/triangulate.ts` uses (see that file): catch the generic
 * mesh error, re-throw this domain's own `PLY_*` code, change nothing
 * else. PLY face elements (`property list ... vertex_indices`) can be
 * arbitrary polygons, not just triangles, so every face this converter
 * reads goes through the same triangulation guarantees OBJ faces do.
 */
import { triangulatePolygon as triangulatePolygonMesh } from "../mesh/triangulate";
import type { TriangulationResult } from "../mesh/triangulate";
import {
  FaceTooSmallError,
  PolygonDegenerateError,
  PolygonNonPlanarError,
  PolygonSelfIntersectingError,
  TriangulationFailedError,
} from "../mesh/errors";
import { plyError } from "./errors";

export type { TriangulationResult };

export function triangulatePolygon(
  vertices: readonly (readonly [number, number, number])[],
  maxIterations: number,
): TriangulationResult {
  try {
    return triangulatePolygonMesh(vertices as [number, number, number][], maxIterations);
  } catch (error) {
    if (error instanceof FaceTooSmallError) throw plyError("PLY_FACE_TOO_SMALL");
    if (error instanceof PolygonDegenerateError) throw plyError("PLY_POLYGON_DEGENERATE");
    if (error instanceof PolygonNonPlanarError) throw plyError("PLY_POLYGON_NON_PLANAR");
    if (error instanceof PolygonSelfIntersectingError) throw plyError("PLY_POLYGON_SELF_INTERSECTING");
    if (error instanceof TriangulationFailedError) throw plyError("PLY_TRIANGULATION_FAILED");
    throw error;
  }
}
