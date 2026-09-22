import { threeMFError } from "./errors";
import { IDENTITY_TRANSFORM, type ThreeMFTransform } from "./types";

export { IDENTITY_TRANSFORM };

/**
 * Parses a 3MF `transform` attribute: 12 space-separated numbers forming a
 * 3x4 affine matrix. Per the 3MF core spec, a point is transformed as a
 * row vector against this layout:
 *
 *   x' = x*t1 + y*t4 + z*t7 + t10
 *   y' = x*t2 + y*t5 + z*t8 + t11
 *   z' = x*t3 + y*t6 + z*t9 + t12
 *
 * i.e. (t1,t2,t3)/(t4,t5,t6)/(t7,t8,t9) are the images of the X/Y/Z basis
 * vectors and (t10,t11,t12) is the translation — NOT a row-major 3x3
 * rotation followed by a separate translation row read in matrix-textbook
 * order. Getting this backwards (transposing the linear part) is the
 * classic row-major/column-major mistake this module's tests guard against.
 */
export function parseTransform(value: string): ThreeMFTransform {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 12) {
    throw threeMFError("THREEMF_XML_MALFORMED");
  }
  const numbers = parts.map(Number);
  for (const n of numbers) {
    if (!Number.isFinite(n)) {
      throw threeMFError("THREEMF_XML_MALFORMED");
    }
  }
  return numbers as unknown as ThreeMFTransform;
}

/**
 * Composes two transforms so that a point is transformed by `inner` first,
 * then `outer` — e.g. a component's own transform (`inner`) followed by
 * the parent object's/build-item's transform (`outer`) when flattening
 * nested components. For p' = p*Ra + Ta then p'' = p'*Rb + Tb:
 * p'' = p*(Ra*Rb) + (Ta*Rb + Tb).
 */
export function composeTransforms(inner: ThreeMFTransform, outer: ThreeMFTransform): ThreeMFTransform {
  const [a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12] = inner;
  const [b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12] = outer;

  const r1 = a1 * b1 + a2 * b4 + a3 * b7;
  const r2 = a1 * b2 + a2 * b5 + a3 * b8;
  const r3 = a1 * b3 + a2 * b6 + a3 * b9;
  const r4 = a4 * b1 + a5 * b4 + a6 * b7;
  const r5 = a4 * b2 + a5 * b5 + a6 * b8;
  const r6 = a4 * b3 + a5 * b6 + a6 * b9;
  const r7 = a7 * b1 + a8 * b4 + a9 * b7;
  const r8 = a7 * b2 + a8 * b5 + a9 * b8;
  const r9 = a7 * b3 + a8 * b6 + a9 * b9;

  const t10 = a10 * b1 + a11 * b4 + a12 * b7 + b10;
  const t11 = a10 * b2 + a11 * b5 + a12 * b8 + b11;
  const t12 = a10 * b3 + a11 * b6 + a12 * b9 + b12;

  return [r1, r2, r3, r4, r5, r6, r7, r8, r9, t10, t11, t12];
}

export function applyTransform(t: ThreeMFTransform, x: number, y: number, z: number): [number, number, number] {
  return [
    x * t[0] + y * t[3] + z * t[6] + t[9],
    x * t[1] + y * t[4] + z * t[7] + t[10],
    x * t[2] + y * t[5] + z * t[8] + t[11],
  ];
}

/**
 * Sign of the determinant of the transform's linear (3x3) part. Negative
 * means the transform reflects/mirrors geometry — a triangle transformed
 * by it needs its winding order flipped afterward, or its cross-product
 * face normal will point inward instead of outward.
 */
export function transformDeterminantSign(t: ThreeMFTransform): -1 | 0 | 1 {
  const [a1, a2, a3, a4, a5, a6, a7, a8, a9] = t;
  const det = a1 * (a5 * a9 - a6 * a8) - a2 * (a4 * a9 - a6 * a7) + a3 * (a4 * a8 - a5 * a7);
  if (det > 0) return 1;
  if (det < 0) return -1;
  return 0;
}
