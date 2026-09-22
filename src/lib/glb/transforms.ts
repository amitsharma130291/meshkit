/**
 * glTF node-transform math. This is deliberately NOT a reuse of 3MF's
 * `transforms.ts` — 3MF's 12-number attribute is a row-vector-convention
 * 3x4 affine matrix, parsed from XML text; glTF's `matrix` is a 16-number
 * **column-major** 4x4 matrix (glTF spec §5.25 / the same convention
 * OpenGL and three.js's `Matrix4.elements` use), and TRS nodes compose as
 * `T × R × S`. Reusing 3MF's parser here would silently transpose the
 * linear part — exactly the row-major/column-major mistake this module's
 * own tests exist to catch.
 */
import { glbError } from "./errors";
import { IDENTITY_MAT4, type Mat4 } from "./types";

const EPS = 1e-12;

export function translationMat4(t: readonly [number, number, number]): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

export function scaleMat4(s: readonly [number, number, number]): Mat4 {
  return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
}

/** `q` is `[x, y, z, w]` — glTF's quaternion component order. Rejects a zero-length quaternion rather than dividing by zero. */
export function quaternionToMat4(q: readonly [number, number, number, number]): Mat4 {
  const [x, y, z, w] = q;
  const lengthSq = x * x + y * y + z * z + w * w;
  if (!Number.isFinite(lengthSq) || lengthSq < EPS) {
    throw glbError("GLB_TRANSFORM_INVALID");
  }
  const invLength = 1 / Math.sqrt(lengthSq);
  const nx = x * invLength;
  const ny = y * invLength;
  const nz = z * invLength;
  const nw = w * invLength;

  const x2 = nx + nx;
  const y2 = ny + ny;
  const z2 = nz + nz;
  const xx = nx * x2;
  const xy = nx * y2;
  const xz = nx * z2;
  const yy = ny * y2;
  const yz = ny * z2;
  const zz = nz * z2;
  const wx = nw * x2;
  const wy = nw * y2;
  const wz = nw * z2;

  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/**
 * Column-major 4x4 multiply: `multiplyMat4(a, b)` applies `b` to a point
 * first, then `a` — i.e. `(a·b)·v = a·(b·v)`. Composing a child's world
 * matrix as `multiplyMat4(parentWorld, local)` therefore means "transform
 * by the local matrix, then by everything the parent already
 * accumulated" — the standard scene-graph parent-to-child order.
 */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out as unknown as Mat4;
}

/** `T × R × S`: scale first, then rotate, then translate — glTF's mandated TRS composition order. */
export function composeTRS(
  translation: readonly [number, number, number],
  rotation: readonly [number, number, number, number],
  scale: readonly [number, number, number],
): Mat4 {
  const t = translationMat4(translation);
  const r = quaternionToMat4(rotation);
  const s = scaleMat4(scale);
  return multiplyMat4(t, multiplyMat4(r, s));
}

export function transformPoint(m: Mat4, p: readonly [number, number, number]): [number, number, number] {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Sign of the determinant of the matrix's upper-left 3x3 (linear) part. Negative means the transform reflects/mirrors geometry. */
export function determinantSign3x3(m: Mat4): -1 | 0 | 1 {
  const a = m[0];
  const b = m[4];
  const c = m[8];
  const d = m[1];
  const e = m[5];
  const f = m[9];
  const g = m[2];
  const h = m[6];
  const i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det > 0) return 1;
  if (det < 0) return -1;
  return 0;
}

export function isFiniteMat4(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(m[i])) return false;
  }
  return true;
}

export { IDENTITY_MAT4 };
