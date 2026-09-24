/**
 * Deterministic fixture builders for STL Diagnostics — every function
 * returns a flat, non-indexed `Float32Array` in STL's own native layout
 * (9 floats per triangle: 3 corners × [x,y,z]), the same shape
 * `STLParseResult.positions` already has, so a fixture can feed either
 * `src/lib/mesh/*` unit tests directly or the full
 * `analyzeSTLDiagnostics()` pipeline unchanged.
 *
 * A note on "open boundary chain": a genuinely open (non-closed) boundary
 * path — exactly two degree-1 endpoints, everything else degree 2 — is
 * NOT realizable as the boundary of any finite, simply-connected,
 * manifold-consistent embedded triangle patch (a basic surface-topology
 * fact: a disk's boundary is always a single closed curve; merging two
 * independently-closed loops at a shared point always produces a
 * degree-4 "branch" vertex, never two degree-1 endpoints). Every mesh
 * fixture below that has an open boundary is a BRANCHED or non-simple
 * one instead, honestly reflecting that constraint. The "open-chain"
 * classification path in `boundary-components.ts` is tested directly
 * against a synthetic edge graph in `boundary-components.test.ts`, not a
 * fabricated (and topologically impossible) 3D mesh.
 */

function tri(out: number[], a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function build(fn: (out: number[]) => void): Float32Array {
  const out: number[] = [];
  fn(out);
  return Float32Array.from(out);
}

/** 4 outward-wound faces, edge length 1 — the simplest possible closed, watertight, consistently-oriented shell. */
export function closedTetrahedron(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0, 1, 0];
  const d: [number, number, number] = [0, 0, 1];
  return build((out) => {
    tri(out, a, c, b); // base, outward = -z
    tri(out, a, b, d);
    tri(out, b, c, d);
    tri(out, c, a, d);
  });
}

/** A unit cube, 12 triangles (2 per face), every face outward-wound (right-hand rule, normal pointing away from the cube's own center). Watertight, closed, consistently orientable, "outward". */
export function outwardClosedCube(): Float32Array {
  return build((out) => cubeFaces(out, false));
}

/** The same cube with every triangle's winding reversed — closed, consistently orientable, but "inward" (signed volume negative under this phase's convention). */
export function inwardClosedCube(): Float32Array {
  return build((out) => cubeFaces(out, true));
}

/** The outward cube with its +Z face's 2 triangles removed — exactly 4 boundary edges forming a single closed square loop (a "hole"). Not closed, not watertight. */
export function openCubeMissingFace(): Float32Array {
  return build((out) => cubeFaces(out, false, "+z"));
}

function cubeFaces(out: number[], reversed: boolean, omitFace?: "+z"): void {
  const p = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const v = {
    n0: p(0, 0, 0), n1: p(1, 0, 0), n2: p(1, 1, 0), n3: p(0, 1, 0),
    n4: p(0, 0, 1), n5: p(1, 0, 1), n6: p(1, 1, 1), n7: p(0, 1, 1),
  };
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
    if (reversed) {
      tri(out, c, b, a);
      tri(out, d, c, a);
    } else {
      tri(out, a, b, c);
      tri(out, a, c, d);
    }
  };
  quad(v.n0, v.n3, v.n2, v.n1); // -z
  if (omitFace !== "+z") quad(v.n4, v.n5, v.n6, v.n7); // +z
  quad(v.n0, v.n1, v.n5, v.n4); // -y
  quad(v.n3, v.n7, v.n6, v.n2); // +y
  quad(v.n0, v.n4, v.n7, v.n3); // -x
  quad(v.n1, v.n2, v.n6, v.n5); // +x
}

/** 2 triangles sharing one diagonal edge (a flat quad) — its 4 outer edges are all boundary, forming exactly one closed 4-edge loop. */
export function singleBoundaryLoop(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [1, 1, 0];
  const d: [number, number, number] = [0, 1, 0];
  return build((out) => {
    tri(out, a, b, c);
    tri(out, a, c, d);
  });
}

/**
 * A closed 3-triangle cone (apex O, rim v0/v1/v2 — a closed boundary loop
 * on its own) plus one extra triangle sharing edge O-v0 a THIRD time
 * (making it non-manifold) and introducing 2 new boundary edges at a
 * fresh vertex v3. The shared vertex O ends up with boundary-degree 3 —
 * a genuine branch point where a "flap" meets the loop. Exercises both
 * the non-manifold-edge and branched-boundary checks in one fixture.
 */
export function branchedBoundaryWithDanglingFlap(): Float32Array {
  const o: [number, number, number] = [0, 0, 1];
  const v0: [number, number, number] = [1, 0, 0];
  const v1: [number, number, number] = [-0.5, 0.87, 0];
  const v2: [number, number, number] = [-0.5, -0.87, 0];
  const v3: [number, number, number] = [2, 0, 0.5];
  return build((out) => {
    tri(out, o, v0, v1);
    tri(out, o, v1, v2);
    tri(out, o, v2, v0);
    tri(out, o, v3, v0); // shares edge O-v0 a 3rd time; adds boundary edges O-v3, v3-v0
  });
}

/** Edge A-B used by 3 distinct triangles — the canonical non-manifold-edge fixture. */
export function threeTrianglesSharingOneEdge(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 1];
  const c: [number, number, number] = [1, 0, 0];
  const d: [number, number, number] = [0, 1, 0];
  const e: [number, number, number] = [-1, -1, 0];
  return build((out) => {
    tri(out, a, b, c);
    tri(out, a, b, d);
    tri(out, a, b, e);
  });
}

/** 2 triangles sharing edge A-B, both traversing it `A -> B` — an inconsistent-winding edge, still manifold (exactly 2 incident triangles). */
export function inconsistentAdjacentWinding(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 1];
  const c: [number, number, number] = [1, 0, 0];
  const d: [number, number, number] = [0, 1, 0];
  return build((out) => {
    tri(out, a, b, c); // a -> b -> c -> a: uses a->b
    tri(out, a, b, d); // a -> b -> d -> a: ALSO uses a->b (should be b->a for consistent winding)
  });
}

/** Two closed tetrahedra with entirely disjoint vertex sets, far apart — 2 shells, no shared geometry at all. */
export function disconnectedShells(): Float32Array {
  return build((out) => {
    appendShifted(out, closedTetrahedron(), [0, 0, 0]);
    appendShifted(out, closedTetrahedron(), [10, 10, 10]);
  });
}

/** Two closed tetrahedra positioned so one vertex of each lands on the EXACT same float32 position — one shared canonical vertex, but no shared edge, so they remain 2 separate shells (a point-only contact never merges shells). */
export function pointTouchingShells(): Float32Array {
  const shared: [number, number, number] = [5, 5, 5];

  // Built explicitly (not via closedTetrahedron + shift) so one exact vertex is `shared`.
  const a = shared;
  const b: [number, number, number] = [6, 5, 4];
  const c: [number, number, number] = [5, 6, 4];
  const d: [number, number, number] = [4.5, 4.5, 4];
  const p = shared;
  const q: [number, number, number] = [4, 5, 6];
  const r: [number, number, number] = [5, 4, 6];
  const s: [number, number, number] = [4.5, 4.5, 6.5];
  return build((out) => {
    tri(out, a, c, b);
    tri(out, a, b, d);
    tri(out, b, c, d);
    tri(out, c, a, d);

    tri(out, p, r, q);
    tri(out, p, q, s);
    tri(out, q, r, s);
    tri(out, r, p, s);
  });
}

function appendShifted(out: number[], positions: Float32Array, offset: readonly [number, number, number]): void {
  for (let i = 0; i < positions.length; i += 3) {
    out.push(positions[i] + offset[0], positions[i + 1] + offset[1], positions[i + 2] + offset[2]);
  }
}

/** A closed tetrahedron plus one extra triangle exactly duplicating one of its faces, same winding. */
export function duplicateFaceSameWinding(): Float32Array {
  return build((out) => {
    appendShifted(out, closedTetrahedron(), [0, 0, 0]);
    tri(out, [0, 0, 0], [0, 1, 0], [1, 0, 0]); // duplicates the base face (a,c,b) exactly
  });
}

/** A closed tetrahedron plus one extra triangle duplicating one of its faces with reversed winding. */
export function duplicateFaceReverseWinding(): Float32Array {
  return build((out) => {
    appendShifted(out, closedTetrahedron(), [0, 0, 0]);
    tri(out, [1, 0, 0], [0, 1, 0], [0, 0, 0]); // reverse of (a,c,b)
  });
}

/** One triangle whose first two corners are the exact same position — a "repeated-vertex" degenerate triangle, alongside one healthy triangle so the mesh has a non-trivial scale to classify against. */
export function repeatedPositionDegeneracy(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    tri(out, [2, 2, 2], [2, 2, 2], [3, 2, 2]);
  });
}

/** One triangle whose 3 corners are exactly collinear — zero area, but 3 distinct vertex positions (not a repeated-vertex case). */
export function zeroAreaCollinearTriangle(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1, 0, 0], [0, 1, 0]); // scale reference
    tri(out, [5, 5, 5], [6, 5, 5], [7, 5, 5]); // collinear along x
  });
}

/** A large reference triangle plus one genuinely tiny sliver triangle, small enough relative to the mesh's own bounding-box diagonal to classify as near-zero-area rather than a legitimate small feature. */
export function nearZeroAreaTriangle(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1000, 0, 0], [0, 1000, 0]); // sets a large scale (diagonal ~1414)
    tri(out, [500, 500, 500], [500.0001, 500, 500], [500, 500.0001, 500]); // area ~5e-9, far below (1e-6*1414)^2 ~ 2e-6
  });
}

/** Two triangles that genuinely cross through each other in 3D (each pierces the other's plane inside the other's own footprint). */
export function properTriangleIntersection(): Float32Array {
  return build((out) => {
    tri(out, [-1, -1, 0], [1, -1, 0], [0, 1, 0]); // in the z=0 plane
    tri(out, [0, 0, -1], [0, 0, 1], [0.5, -0.5, 0]); // pierces through the first triangle's interior near (0, -0.1, 0)
  });
}

/** Two coplanar (z=0) triangles that overlap in area but share no vertex or edge. */
export function nonAdjacentCoplanarOverlap(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [4, 0, 0], [0, 4, 0]);
    tri(out, [1, 1, 0], [5, 1, 0], [1, 5, 0]);
  });
}

/** Two triangles sharing exactly one edge, properly wound (ordinary manifold adjacency — expected to be EXCLUDED from self-intersection reporting). */
export function adjacentSharedEdgeTriangles(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    tri(out, [1, 0, 0], [1, 1, 0], [0, 1, 0]);
  });
}

/** Two triangles sharing exactly one vertex, positioned so they otherwise don't cross — expected to be tested (not blanket-excluded) and found non-intersecting. */
export function sharedVertexOnlyTriangles(): Float32Array {
  const shared: [number, number, number] = [0, 0, 0];
  return build((out) => {
    tri(out, shared, [1, 0, 0], [0, 1, 0]);
    tri(out, shared, [-1, 0, 0], [0, -1, 0]);
  });
}

/** The outward unit cube translated far from the origin — signed volume should still equal the untranslated cube's volume (1), verifying the origin-relative tetrahedron sum is genuinely translation-invariant for a closed shell. */
export function translatedClosedShell(): Float32Array {
  return build((out) => appendShifted(out, outwardClosedCube(), [37.5, -12.25, 8]));
}

/** The outward unit cube reflected across the X axis (mirrored, which inverts a closed shell's orientation) — signed volume should flip sign relative to the un-reflected cube. */
export function reflectedClosedShell(): Float32Array {
  return build((out) => {
    const src = outwardClosedCube();
    for (let i = 0; i < src.length; i += 3) out.push(-src[i], src[i + 1], src[i + 2]);
  });
}

/**
 * The outward unit cube translated to a very large coordinate offset
 * relative to its own size — stresses floating-point cancellation in the
 * signed-volume sum (large, nearly-canceling terms) far more than
 * `translatedClosedShell()`'s modest offset does.
 */
export function largeCancellationFixture(): Float32Array {
  return build((out) => appendShifted(out, outwardClosedCube(), [100_000, 100_000, 100_000]));
}
