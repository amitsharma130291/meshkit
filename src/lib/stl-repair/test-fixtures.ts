/**
 * Repair-specific fixture builders, extending
 * `stl-diagnostics/test-fixtures.ts` (reused directly for every fixture
 * Phase 5 already covers — exact duplicates, zero-area triangles, same/
 * reverse-winding duplicates, inconsistent winding, inward shells, open
 * shells, multiple shells — repair-specific tests import those unchanged
 * rather than rebuilding equivalents here).
 */

function tri(out: number[], a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function build(fn: (out: number[]) => void): Float32Array {
  const out: number[] = [];
  fn(out);
  return Float32Array.from(out);
}

/**
 * Two triangles that ALMOST share an edge — one triangle's edge runs
 * from (1,0,0) to (1,1,0), the other's matching edge runs from
 * (1.0005,0,0) to (1.0005,1,0), a seam gap of 0.0005 model units (well
 * within a typical welding tolerance derived from this fixture's own
 * ~1.4-unit bounding-box diagonal). Not topologically connected as-is —
 * both edges are boundary.
 */
export function nearDuplicateSeam(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1, 0, 0], [1, 1, 0]);
    tri(out, [0, 0, 0], [1, 1, 0], [0, 1, 0]);
    tri(out, [1.0005, 0, 0], [2, 0, 0], [2, 1, 0]);
    tri(out, [1.0005, 0, 0], [2, 1, 0], [1.0005, 1, 0]);
  });
}

/**
 * A thin sliver triangle whose two "close" corners (0.00001 apart) will
 * collapse into a single point once welded at a tolerance larger than
 * that gap but smaller than the triangle's own longer edges — the
 * triangle becomes degenerate (2 identical vertices) and must be removed
 * as part of welding, not left in the output.
 */
export function weldCollapsesSliver(): Float32Array {
  return build((out) => {
    tri(out, [0, 0, 0], [1, 0, 0], [0, 1, 0]); // scale reference (diagonal ~1.4)
    tri(out, [5, 5, 5], [5.00001, 5, 5], [5, 6, 5]); // sliver: first two corners 0.00001 apart
  });
}

/** A large closed cube plus one small, fully separate closed tetrahedron far away — a "small shell" candidate for opt-in removal, both by triangle count (4 vs 12) and by relative surface area. */
export function largeCubeWithSmallDetachedTetrahedron(): Float32Array {
  return build((out) => {
    // Unit cube (12 triangles), then a tiny tetrahedron (4 triangles) far away and much smaller.
    const p = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    const v = {
      n0: p(0, 0, 0), n1: p(1, 0, 0), n2: p(1, 1, 0), n3: p(0, 1, 0),
      n4: p(0, 0, 1), n5: p(1, 0, 1), n6: p(1, 1, 1), n7: p(0, 1, 1),
    };
    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
      tri(out, a, b, c);
      tri(out, a, c, d);
    };
    quad(v.n0, v.n3, v.n2, v.n1);
    quad(v.n4, v.n5, v.n6, v.n7);
    quad(v.n0, v.n1, v.n5, v.n4);
    quad(v.n3, v.n7, v.n6, v.n2);
    quad(v.n0, v.n4, v.n7, v.n3);
    quad(v.n1, v.n2, v.n6, v.n5);

    // A tetrahedron far smaller than the cube (by triangle count, surface
    // area, and bounding-box diagonal) but still comfortably clear of
    // Phase 5's own scale-relative near-zero-area threshold — kept close
    // enough to the cube that it doesn't itself inflate the whole mesh's
    // bounding-box diagonal (which the threshold is relative to).
    const s = 0.2;
    const ox = 5, oy = 5, oz = 5;
    const a: [number, number, number] = [ox, oy, oz];
    const b: [number, number, number] = [ox + s, oy, oz];
    const c: [number, number, number] = [ox, oy + s, oz];
    const d: [number, number, number] = [ox, oy, oz + s];
    tri(out, a, c, b);
    tri(out, a, b, d);
    tri(out, b, c, d);
    tri(out, c, a, d);
  });
}
