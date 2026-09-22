/**
 * OBJ-specific compatibility wrapper around the canonical, format-neutral
 * triangulator in `src/lib/mesh/triangulate.ts` (moved there in Phase 3F
 * so the PLY reader could reuse it). Preserves this module's exact
 * pre-Phase-3F public API and exact `OBJ_*` error codes — same pattern as
 * the `src/lib/obj/deduplicate.ts`/`number-format.ts` wrappers introduced
 * in Phase 3E: catch the generic mesh error, re-throw the domain-specific
 * one, change nothing else.
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
import { objError } from "./errors";

export type { TriangulationResult };

export function triangulatePolygon(
  vertices: readonly (readonly [number, number, number])[],
  maxIterations: number,
): TriangulationResult {
  try {
    return triangulatePolygonMesh(vertices as [number, number, number][], maxIterations);
  } catch (error) {
    if (error instanceof FaceTooSmallError) throw objError("OBJ_FACE_TOO_SMALL");
    if (error instanceof PolygonDegenerateError) throw objError("OBJ_POLYGON_DEGENERATE");
    if (error instanceof PolygonNonPlanarError) throw objError("OBJ_POLYGON_NON_PLANAR");
    if (error instanceof PolygonSelfIntersectingError) throw objError("OBJ_POLYGON_SELF_INTERSECTING");
    if (error instanceof TriangulationFailedError) throw objError("OBJ_TRIANGULATION_FAILED");
    throw error;
  }
}
