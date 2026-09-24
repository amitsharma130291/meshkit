/**
 * Deterministic fixture builders specific to STL Optimization's own
 * geometry needs (density/shape variants a simplifier cares about that
 * `stl-diagnostics/test-fixtures.ts` never needed). Every topology-DEFECT
 * fixture this phase's own tests need (non-manifold edge, winding
 * conflict, duplicate/degenerate faces, self-intersection, disconnected/
 * point-touching shells, a large cancellation-budget mesh) is reused
 * directly from `stl-diagnostics/test-fixtures.ts` at each test's own
 * import site instead of being redefined a second time here.
 */
function tri(out: number[], a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function build(fn: (out: number[]) => void): Float32Array {
  const out: number[] = [];
  fn(out);
  return Float32Array.from(out);
}

/** A flat NxN grid of quads (2*N*N triangles) — the simplest non-trivial case with abundant safe interior collapses. */
export function subdividedPlane(n = 6): Float32Array {
  return build((out) => {
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const a: [number, number, number] = [gx, gy, 0];
        const b: [number, number, number] = [gx + 1, gy, 0];
        const c: [number, number, number] = [gx + 1, gy + 1, 0];
        const d: [number, number, number] = [gx, gy + 1, 0];
        tri(out, a, b, c);
        tri(out, a, c, d);
      }
    }
  });
}

/** Same shape as `subdividedPlane` — kept as its own named fixture per the task's own fixture list, since "subdivided plane" and "triangulated grid" name the same construction from two different angles (uniform flat quad grid). */
export function triangulatedGrid(n = 6): Float32Array {
  return subdividedPlane(n);
}

/** A cube with each face subdivided into an NxN quad grid — closed, watertight, safely simplifiable per-face. */
export function subdividedCube(n = 4): Float32Array {
  return build((out) => {
    const faces: [[number, number, number], [number, number, number], [number, number, number]][] = [
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], // +Z face basis: origin, u, v
      [[0, 0, 0], [0, 1, 0], [1, 0, 0]], // -Z
      [[0, 1, 1], [1, 0, 0], [0, 0, -1]], // +Y
      [[0, 0, 0], [1, 0, 0], [0, 0, 1]], // -Y
      [[1, 0, 1], [0, 1, 0], [0, 0, -1]], // +X
      [[0, 0, 0], [0, 0, 1], [0, 1, 0]], // -X
    ];
    for (const [origin, uDir, vDir] of faces) {
      const point = (u: number, v: number): [number, number, number] => [
        origin[0] + uDir[0] * u + vDir[0] * v,
        origin[1] + uDir[1] * u + vDir[1] * v,
        origin[2] + uDir[2] * u + vDir[2] * v,
      ];
      for (let gu = 0; gu < n; gu++) {
        for (let gv = 0; gv < n; gv++) {
          const a = point(gu / n, gv / n);
          const b = point((gu + 1) / n, gv / n);
          const c = point((gu + 1) / n, (gv + 1) / n);
          const d = point(gu / n, (gv + 1) / n);
          tri(out, a, b, c);
          tri(out, a, c, d);
        }
      }
    }
  });
}

/** A closed, properly-capped UV-sphere — smoothly curved, no sharp features, abundant safe collapses everywhere. */
export function smoothSphere(latSegments = 16, lonSegments = 32): Float32Array {
  return build((out) => {
    const vertex = (lat: number, lon: number): [number, number, number] => {
      // `lon` must be wrapped BEFORE computing phi: MeshWrench's own vertex
      // identity is bit-exact (no tolerance welding — see
      // `mesh/canonical-vertices.ts`'s own documented policy), and
      // `Math.sin(2*Math.PI)` is not bit-identical to `Math.sin(0)` in
      // IEEE754. Computing phi from the raw (unwrapped) `lonSegments`
      // value at the seam produces a vertex numerically equal to, but not
      // bit-identical to, the lon=0 vertex — silently splitting the seam
      // into two non-welded edges and leaving the sphere non-watertight.
      // Discovered by this fixture's own first test run (see the
      // completion report's TDD discoveries).
      const wrappedLon = lon % lonSegments;
      const theta = (lat / latSegments) * Math.PI;
      const phi = (wrappedLon / lonSegments) * 2 * Math.PI;
      return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    };
    const north: [number, number, number] = [0, 1, 0];
    const south: [number, number, number] = [0, -1, 0];
    for (let lon = 0; lon < lonSegments; lon++) tri(out, north, vertex(1, lon), vertex(1, lon + 1));
    for (let lat = 1; lat < latSegments - 1; lat++) {
      for (let lon = 0; lon < lonSegments; lon++) {
        tri(out, vertex(lat, lon), vertex(lat + 1, lon), vertex(lat + 1, lon + 1));
        tri(out, vertex(lat, lon), vertex(lat + 1, lon + 1), vertex(lat, lon + 1));
      }
    }
    for (let lon = 0; lon < lonSegments; lon++) tri(out, south, vertex(latSegments - 1, lon + 1), vertex(latSegments - 1, lon));
  });
}

/** A cube where each face is a single quad (2 triangles) — sharp 90° edges throughout, the canonical "must not round away a sharp edge" test case. */
export function sharpCube(size = 1): Float32Array {
  return build((out) => {
    const s = size;
    const p = (x: number, y: number, z: number): [number, number, number] => [x * s, y * s, z * s];
    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
      tri(out, a, b, c);
      tri(out, a, c, d);
    };
    quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)); // +Z
    quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)); // -Z
    quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)); // +Y
    quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)); // -Y
    quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)); // +X
    quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)); // -X
  });
}

/** A cube with each edge replaced by a narrow bevel face — sharp-ish but not perfectly 90°, a mid-severity feature-preservation case. */
export function beveledCube(size = 1, bevel = 0.15): Float32Array {
  return build((out) => {
    const s = size;
    const b = bevel;
    // A simple octagonal-prism approximation of a beveled cube: an inset top/bottom
    // face connected to the outer body via 4 angled bevel strips per side.
    const outerTop: [number, number, number][] = [
      [0, s, 0], [s, s, 0], [s, s, s], [0, s, s],
    ];
    const innerTop: [number, number, number][] = outerTop.map(([x, y, z]) => [x + (x === 0 ? b : -b), y - b, z + (z === 0 ? b : -b)]);
    const outerBottom: [number, number, number][] = [
      [0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s],
    ];
    const innerBottom: [number, number, number][] = outerBottom.map(([x, y, z]) => [x + (x === 0 ? b : -b), y + b, z + (z === 0 ? b : -b)]);

    const fan = (center: [number, number, number], ring: [number, number, number][]) => {
      for (let i = 0; i < ring.length; i++) tri(out, center, ring[i], ring[(i + 1) % ring.length]);
    };
    const innerTopCenter: [number, number, number] = [s / 2, s - b, s / 2];
    const innerBottomCenter: [number, number, number] = [s / 2, b, s / 2];
    fan(innerTopCenter, innerTop);
    fan(innerBottomCenter, [...innerBottom].reverse());

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      // Bevel strip (outer top edge -> inner top edge).
      tri(out, outerTop[i], outerTop[j], innerTop[j]);
      tri(out, outerTop[i], innerTop[j], innerTop[i]);
      // Side wall (outer top -> outer bottom).
      tri(out, outerTop[i], outerBottom[i], outerBottom[j]);
      tri(out, outerTop[i], outerBottom[j], outerTop[j]);
      // Bevel strip (outer bottom edge -> inner bottom edge).
      tri(out, outerBottom[i], innerBottom[i], innerBottom[j]);
      tri(out, outerBottom[i], innerBottom[j], outerBottom[j]);
    }
  });
}

/** A long thin triangular ridge (a "roof" shape) — a single sharp crease running down its length. */
export function ridge(length = 6, height = 0.5): Float32Array {
  return build((out) => {
    for (let i = 0; i < length; i++) {
      const x0 = i;
      const x1 = i + 1;
      const peak0: [number, number, number] = [x0, height, 0];
      const peak1: [number, number, number] = [x1, height, 0];
      const left0: [number, number, number] = [x0, 0, -1];
      const left1: [number, number, number] = [x1, 0, -1];
      const right0: [number, number, number] = [x0, 0, 1];
      const right1: [number, number, number] = [x1, 0, 1];
      tri(out, left0, left1, peak1);
      tri(out, left0, peak1, peak0);
      tri(out, peak0, peak1, right1);
      tri(out, peak0, right1, right0);
    }
  });
}

/** A thin rectangular wall (high aspect ratio, two nearly-coincident faces) — stresses the normal-flip/degenerate guards. */
export function thinWall(width = 4, height = 4, thickness = 0.02): Float32Array {
  return build((out) => {
    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
      tri(out, a, b, c);
      tri(out, a, c, d);
    };
    quad([0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]);
    quad([0, 0, thickness], [0, height, thickness], [width, height, thickness], [width, 0, thickness]);
    quad([0, 0, 0], [0, height, 0], [0, height, thickness], [0, 0, thickness]);
    quad([width, 0, 0], [width, 0, thickness], [width, height, thickness], [width, height, 0]);
    quad([0, 0, 0], [0, 0, thickness], [width, 0, thickness], [width, 0, 0]);
    quad([0, height, 0], [width, height, 0], [width, height, thickness], [0, height, thickness]);
  });
}

/** Two closed cubes, well-separated — distinct shells that must each keep their own minimum triangle budget. */
export function twoDistinctShells(gap = 20): Float32Array {
  const cube = (offset: number): Float32Array => {
    const shifted = subdividedCube(2);
    for (let i = 0; i < shifted.length; i += 3) shifted[i] += offset;
    return shifted;
  };
  return Float32Array.from([...cube(0), ...cube(gap)]);
}

/** Two closed cubes close together but not touching — must not be merged or treated as one shell just because they're spatially near. */
export function closeDisconnectedShells(gap = 0.05): Float32Array {
  const cube = (offset: number): Float32Array => {
    const shifted = subdividedCube(2);
    for (let i = 0; i < shifted.length; i += 3) shifted[i] += offset;
    return shifted;
  };
  return Float32Array.from([...cube(0), ...cube(1 + gap)]);
}

/** A large main shell plus a tiny second shell — the "small shell too small to reduce further" case for shell-target-allocation tests. */
export function smallProtectedShell(): Float32Array {
  const large = subdividedCube(6);
  const small = build((out) => {
    const a: [number, number, number] = [20, 20, 20];
    const b: [number, number, number] = [20.1, 20, 20];
    const c: [number, number, number] = [20, 20.1, 20];
    const d: [number, number, number] = [20, 20, 20.1];
    tri(out, a, c, b);
    tri(out, a, b, d);
    tri(out, a, d, c);
    tri(out, b, c, d);
  });
  return Float32Array.from([...large, ...small]);
}
