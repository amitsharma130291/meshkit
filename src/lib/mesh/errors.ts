/**
 * Format-agnostic exceptions for `src/lib/mesh/`'s shared geometry
 * utilities. Deliberately NOT tied to any specific converter's
 * `ErrorCode` prefix — `number-format.ts` and `deduplicate.ts` are used
 * by both the OBJ writer (Phase 3D) and the 3MF writer (Phase 3E), and
 * each needs to surface its OWN domain-specific error code
 * (`OBJ_NON_FINITE_OUTPUT` vs `THREEMF_NON_FINITE_OUTPUT`, etc.) to the
 * user. Callers catch these generic types and translate them at the
 * boundary — see `src/lib/obj/number-format.ts`/`deduplicate.ts` (thin
 * compatibility wrappers) for the pattern.
 */
export class NonFiniteCoordinateError extends Error {
  constructor() {
    super("non-finite coordinate");
    this.name = "NonFiniteCoordinateError";
  }
}

export class UniqueVertexLimitExceededError extends Error {
  constructor() {
    super("unique vertex limit exceeded");
    this.name = "UniqueVertexLimitExceededError";
  }
}

/**
 * Thrown by `src/lib/mesh/triangulate.ts` — shared by the OBJ writer's
 * (Phase 3B) face triangulation and the PLY writer's (Phase 3F) polygon
 * triangulation, the same generic/domain-specific split established for
 * `deduplicate.ts`/`number-format.ts` in Phase 3E.
 */
export class FaceTooSmallError extends Error {
  constructor() {
    super("face has fewer than three vertices");
    this.name = "FaceTooSmallError";
  }
}

export class PolygonDegenerateError extends Error {
  constructor() {
    super("polygon has no measurable area");
    this.name = "PolygonDegenerateError";
  }
}

export class PolygonNonPlanarError extends Error {
  constructor() {
    super("polygon deviates too far from planar");
    this.name = "PolygonNonPlanarError";
  }
}

export class PolygonSelfIntersectingError extends Error {
  constructor() {
    super("polygon edges cross themselves");
    this.name = "PolygonSelfIntersectingError";
  }
}

export class TriangulationFailedError extends Error {
  constructor() {
    super("polygon could not be triangulated safely");
    this.name = "TriangulationFailedError";
  }
}
