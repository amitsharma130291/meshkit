/**
 * Quadric Error Metrics (Garland & Heckbert). A quadric is the symmetric
 * 4x4 matrix `Q = p * p^T` for a plane `p = [a,b,c,d]` (`ax+by+cz+d=0`,
 * normalized so `a²+b²+c²=1`), so a homogeneous point `v=[x,y,z,1]`'s
 * squared perpendicular distance to the plane is exactly `v^T Q v`.
 * Stored as the 10 unique upper-triangular entries — the matrix is
 * symmetric by construction (it's always `p*p^T`), so there is nothing to
 * separately store or disagree for the lower triangle.
 */
export interface Quadric {
  a2: number;
  ab: number;
  ac: number;
  ad: number;
  b2: number;
  bc: number;
  bd: number;
  c2: number;
  cd: number;
  d2: number;
}

export const ZERO_QUADRIC: Quadric = { a2: 0, ab: 0, ac: 0, ad: 0, b2: 0, bc: 0, bd: 0, c2: 0, cd: 0, d2: 0 };

function assertFinite(values: number[], label: string): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error(`${label}: non-finite input`);
  }
}

/** Builds a quadric from an already-oriented plane `ax+by+cz+d=0`; `a,b,c` need not be pre-normalized (this normalizes). */
export function planeQuadric(a: number, b: number, c: number, d: number): Quadric {
  assertFinite([a, b, c, d], "planeQuadric");
  const length = Math.sqrt(a * a + b * b + c * c);
  if (length < 1e-12) throw new Error("planeQuadric: degenerate (zero-length) normal");
  const na = a / length;
  const nb = b / length;
  const nc = c / length;
  const nd = d / length;
  return {
    a2: na * na,
    ab: na * nb,
    ac: na * nc,
    ad: na * nd,
    b2: nb * nb,
    bc: nb * nc,
    bd: nb * nd,
    c2: nc * nc,
    cd: nc * nd,
    d2: nd * nd,
  };
}

/** Builds the plane quadric for a triangle's own supporting plane from its three corners. */
export function triangleQuadric(p0: readonly [number, number, number], p1: readonly [number, number, number], p2: readonly [number, number, number]): Quadric {
  assertFinite([...p0, ...p1, ...p2], "triangleQuadric");
  const e1: [number, number, number] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2: [number, number, number] = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  // Cross product gives the (unnormalized) plane normal [a,b,c].
  const a = e1[1] * e2[2] - e1[2] * e2[1];
  const b = e1[2] * e2[0] - e1[0] * e2[2];
  const c = e1[0] * e2[1] - e1[1] * e2[0];
  const length = Math.sqrt(a * a + b * b + c * c);
  if (length < 1e-12) throw new Error("triangleQuadric: degenerate (zero-area) triangle");
  const d = -(a * p0[0] + b * p0[1] + c * p0[2]);
  return planeQuadric(a, b, c, d);
}

export function addQuadric(x: Quadric, y: Quadric): Quadric {
  return {
    a2: x.a2 + y.a2,
    ab: x.ab + y.ab,
    ac: x.ac + y.ac,
    ad: x.ad + y.ad,
    b2: x.b2 + y.b2,
    bc: x.bc + y.bc,
    bd: x.bd + y.bd,
    c2: x.c2 + y.c2,
    cd: x.cd + y.cd,
    d2: x.d2 + y.d2,
  };
}

/** `v^T Q v` for homogeneous `v=[x,y,z,1]` — the summed squared perpendicular distance to every plane folded into `q`. */
export function evaluateQuadric(q: Quadric, point: readonly [number, number, number]): number {
  const [x, y, z] = point;
  return (
    q.a2 * x * x +
    2 * q.ab * x * y +
    2 * q.ac * x * z +
    2 * q.ad * x +
    q.b2 * y * y +
    2 * q.bc * y * z +
    2 * q.bd * y +
    q.c2 * z * z +
    2 * q.cd * z +
    q.d2
  );
}

export interface OptimalPositionResult {
  ok: boolean;
  position: [number, number, number] | null;
}

/**
 * Minimizes `v^T Q v` by solving the 3x3 linear system from the gradient
 * (`A v = b`, `A` = the upper-left 3x3 symmetric block, `b =
 * -[ad,bd,cd]`). Uses Cramer's rule — a mesh-simplification quadric is
 * always exactly 3x3, so a general solver would be needless machinery.
 * Not `ok` (caller must fall back — see `collapse-validation.ts`'s
 * midpoint/endpoint policy) whenever the matrix is singular or
 * near-singular, since Cramer's rule divides by its determinant.
 */
export function solveOptimalPosition(q: Quadric): OptimalPositionResult {
  const { a2, ab, ac, ad, b2, bc, bd, c2, cd } = q;
  // A = [[a2,ab,ac],[ab,b2,bc],[ac,bc,c2]], b = [-ad,-bd,-cd]
  const det =
    a2 * (b2 * c2 - bc * bc) -
    ab * (ab * c2 - bc * ac) +
    ac * (ab * bc - b2 * ac);

  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    return { ok: false, position: null };
  }

  const bx = -ad;
  const by = -bd;
  const bz = -cd;

  // Cramer's rule: replace each column of A with b in turn.
  const detX =
    bx * (b2 * c2 - bc * bc) -
    ab * (by * c2 - bc * bz) +
    ac * (by * bc - b2 * bz);
  const detY =
    a2 * (by * c2 - bz * bc) -
    bx * (ab * c2 - bc * ac) +
    ac * (ab * bz - by * ac);
  const detZ =
    a2 * (b2 * bz - by * bc) -
    ab * (ab * bz - by * ac) +
    bx * (ab * bc - b2 * ac);

  const x = detX / det;
  const y = detY / det;
  const z = detZ / det;

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { ok: false, position: null };
  }
  return { ok: true, position: [x, y, z] };
}
