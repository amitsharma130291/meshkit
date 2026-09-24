/**
 * FBX node-transform evaluation. Deliberately its own module, not a reuse
 * of `glb/transforms.ts` — glTF composes a node's local matrix as the
 * simple `T × R × S` (with `R` a quaternion), while FBX composes a much
 * richer stack of translation/pivot/pre-post-rotation/scale terms driven
 * by Euler angles in a *declared* rotation order:
 *
 *   Local = T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
 *
 * (the FBX SDK's own documented node-transform formula — "Roff"/"Rp"/
 * "Soff"/"Sp" are translations to/from the rotation/scaling pivot points;
 * "Rpre"/"Rpost" are always evaluated in XYZ order regardless of the
 * node's own declared rotation order, which only governs the main "R"
 * term; "Rpost" is *inverted* — a well-known gotcha this module's own
 * tests exist to catch).
 *
 * A node's *geometric* transform (`Gt·Gr·Gs`) is a completely separate,
 * simpler T×R×S applied only to that node's own attached mesh vertices —
 * never composed into the matrix propagated to children. Keeping these
 * two matrices as genuinely separate values (never merged into one
 * "world matrix" until the point where a specific mesh's vertices are
 * actually transformed) is what makes that separation possible.
 */
import { fbxError } from "./errors";
import type { FBXProperty } from "./types";

export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export type FBXRotationOrder = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type FBXInheritType = 0 | 1 | 2;

const DEG2RAD = Math.PI / 180;

export function translationMat4(t: readonly [number, number, number]): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

export function scaleMat4(s: readonly [number, number, number]): Mat4 {
  return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
}

function rotationXMat4(radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

function rotationYMat4(radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function rotationZMat4(radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major 4x4 multiply: `multiplyMat4(a, b)` applies `b` to a point first, then `a` — `(a·b)·v = a·(b·v)`. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out as unknown as Mat4;
}

function multiplyAll(mats: Mat4[]): Mat4 {
  return mats.reduce((acc, m) => multiplyMat4(acc, m), IDENTITY_MAT4);
}

/**
 * Composes an Euler-angle triple (in **degrees**, converted to radians
 * exactly once here — never passed straight to `Math.sin`/`Math.cos`, the
 * "degrees treated as radians" bug this function's own tests guard
 * against) into a rotation matrix, in the FBX-declared axis order. For
 * order `[A, B, C]` (rotate about A, then B, then C, as intrinsic axis
 * rotations), the resulting point-transform matrix is `Rc · Rb · Ra` —
 * the reverse of the named sequence — matching the FBX SDK's own
 * convention.
 */
export function eulerToMat4(degrees: readonly [number, number, number], order: FBXRotationOrder): Mat4 {
  const rx = rotationXMat4(degrees[0] * DEG2RAD);
  const ry = rotationYMat4(degrees[1] * DEG2RAD);
  const rz = rotationZMat4(degrees[2] * DEG2RAD);

  switch (order) {
    case 0: // XYZ
      return multiplyAll([rz, ry, rx]);
    case 1: // XZY
      return multiplyAll([ry, rz, rx]);
    case 2: // YZX
      return multiplyAll([rx, rz, ry]);
    case 3: // YXZ
      return multiplyAll([rz, rx, ry]);
    case 4: // ZXY
      return multiplyAll([ry, rx, rz]);
    case 5: // ZYX
      return multiplyAll([rx, ry, rz]);
    default:
      // SphericXYZ (6) — a rare, gimbal/spherical rotation representation
      // this phase doesn't implement; the caller is expected to have
      // already warned and substituted order 0 before reaching here.
      return multiplyAll([rz, ry, rx]);
  }
}

/** Transpose of a pure-rotation matrix's 3x3 part is its inverse — valid only for an orthonormal rotation matrix (which every `Rpost` built by `eulerToMat4` always is), never a general 4x4 inverse. */
export function invertRotationMat4(m: Mat4): Mat4 {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
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

/** Sign of the determinant of the matrix's upper-left 3x3 (linear) part. Negative means the transform reflects/mirrors geometry — the case `resolve-scene.ts` corrects triangle winding for. */
export function determinantSign3x3(m: Mat4): -1 | 0 | 1 {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
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

export interface FBXNodeTransformProperties {
  translation: [number, number, number];
  rotationOffset: [number, number, number];
  rotationPivot: [number, number, number];
  preRotation: [number, number, number];
  rotation: [number, number, number];
  postRotation: [number, number, number];
  scalingOffset: [number, number, number];
  scalingPivot: [number, number, number];
  scaling: [number, number, number];
  rotationOrder: FBXRotationOrder;
  inheritType: FBXInheritType;
  geometricTranslation: [number, number, number];
  geometricRotation: [number, number, number];
  geometricScaling: [number, number, number];
}

function readVec3(props: Map<string, FBXProperty[]>, name: string, fallback: [number, number, number]): [number, number, number] {
  const values = props.get(name);
  if (!values || values.length < 3) return fallback;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = values[i];
    if (!v || (v.type !== "D" && v.type !== "F" && v.type !== "I")) return fallback;
    out.push(v.value);
  }
  return out as [number, number, number];
}

function readEnum<T extends number>(props: Map<string, FBXProperty[]>, name: string, fallback: T, valid: readonly T[]): T {
  const v = props.get(name)?.[0];
  if (!v || (v.type !== "I" && v.type !== "Y")) return fallback;
  return (valid as readonly number[]).includes(v.value) ? (v.value as T) : fallback;
}

const ROTATION_ORDERS: readonly FBXRotationOrder[] = [0, 1, 2, 3, 4, 5, 6];
const INHERIT_TYPES: readonly FBXInheritType[] = [0, 1, 2];

export function readNodeTransformProperties(props: Map<string, FBXProperty[]>): FBXNodeTransformProperties {
  return {
    translation: readVec3(props, "Lcl Translation", [0, 0, 0]),
    rotationOffset: readVec3(props, "RotationOffset", [0, 0, 0]),
    rotationPivot: readVec3(props, "RotationPivot", [0, 0, 0]),
    preRotation: readVec3(props, "PreRotation", [0, 0, 0]),
    rotation: readVec3(props, "Lcl Rotation", [0, 0, 0]),
    postRotation: readVec3(props, "PostRotation", [0, 0, 0]),
    scalingOffset: readVec3(props, "ScalingOffset", [0, 0, 0]),
    scalingPivot: readVec3(props, "ScalingPivot", [0, 0, 0]),
    scaling: readVec3(props, "Lcl Scaling", [1, 1, 1]),
    rotationOrder: readEnum(props, "RotationOrder", 0, ROTATION_ORDERS),
    inheritType: readEnum(props, "InheritType", 0, INHERIT_TYPES),
    geometricTranslation: readVec3(props, "GeometricTranslation", [0, 0, 0]),
    geometricRotation: readVec3(props, "GeometricRotation", [0, 0, 0]),
    geometricScaling: readVec3(props, "GeometricScaling", [1, 1, 1]),
  };
}

/** The node's own local transform (T·Roff·Rp·Rpre·R·Rpost⁻¹·Rp⁻¹·Soff·Sp·S·Sp⁻¹) — what a child node's world matrix is composed against. Never includes the geometric transform. */
export function composeLocalMatrix(t: FBXNodeTransformProperties): Mat4 {
  const rotationOrder: FBXRotationOrder = t.rotationOrder === 6 ? 0 : t.rotationOrder; // SphericXYZ unsupported — fall back to XYZ (caller warns)

  const negRotationPivot: [number, number, number] = [-t.rotationPivot[0], -t.rotationPivot[1], -t.rotationPivot[2]];
  const negScalingPivot: [number, number, number] = [-t.scalingPivot[0], -t.scalingPivot[1], -t.scalingPivot[2]];

  const T = translationMat4(t.translation);
  const Roff = translationMat4(t.rotationOffset);
  const Rp = translationMat4(t.rotationPivot);
  const Rpre = eulerToMat4(t.preRotation, 0); // always XYZ, independent of the node's own RotationOrder
  const R = eulerToMat4(t.rotation, rotationOrder);
  const RpostInv = invertRotationMat4(eulerToMat4(t.postRotation, 0)); // always XYZ; inverted per the FBX SDK formula
  const RpInv = translationMat4(negRotationPivot);
  const Soff = translationMat4(t.scalingOffset);
  const Sp = translationMat4(t.scalingPivot);
  const S = scaleMat4(t.scaling);
  const SpInv = translationMat4(negScalingPivot);

  return multiplyAll([T, Roff, Rp, Rpre, R, RpostInv, RpInv, Soff, Sp, S, SpInv]);
}

/** `Gt · Gr · Gs` — applies only to this node's own attached mesh, at the point of transforming its vertices; never composed into the matrix handed to children. */
export function composeGeometricMatrix(t: FBXNodeTransformProperties): Mat4 {
  const isIdentity =
    t.geometricTranslation[0] === 0 && t.geometricTranslation[1] === 0 && t.geometricTranslation[2] === 0 &&
    t.geometricRotation[0] === 0 && t.geometricRotation[1] === 0 && t.geometricRotation[2] === 0 &&
    t.geometricScaling[0] === 1 && t.geometricScaling[1] === 1 && t.geometricScaling[2] === 1;
  if (isIdentity) return IDENTITY_MAT4;

  const Gt = translationMat4(t.geometricTranslation);
  const Gr = eulerToMat4(t.geometricRotation, 0); // always XYZ
  const Gs = scaleMat4(t.geometricScaling);
  return multiplyMat4(Gt, multiplyMat4(Gr, Gs));
}

/** Inverse-transpose of the matrix's upper-left 3x3 (linear) part — the mathematically correct transform for a normal vector under non-uniform scale or reflection; a position transform (or the naive world matrix) would tilt a normal away from perpendicular. `null` for a singular (non-invertible) linear part. */
export function computeNormalMatrix(m: Mat4): readonly [number, number, number, number, number, number, number, number, number] | null {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    (e * i - f * h) * invDet, (f * g - d * i) * invDet, (d * h - e * g) * invDet,
    (c * h - b * i) * invDet, (a * i - c * g) * invDet, (b * g - a * h) * invDet,
    (b * f - c * e) * invDet, (c * d - a * f) * invDet, (a * e - b * d) * invDet,
  ];
}

export function applyNormalMatrix(nm: readonly number[], nx: number, ny: number, nz: number): [number, number, number] {
  const x = nm[0] * nx + nm[1] * ny + nm[2] * nz;
  const y = nm[3] * nx + nm[4] * ny + nm[5] * nz;
  const z = nm[6] * nx + nm[7] * ny + nm[8] * nz;
  const lengthSq = x * x + y * y + z * z;
  if (!Number.isFinite(lengthSq) || lengthSq < 1e-12) return [nx, ny, nz];
  const inv = 1 / Math.sqrt(lengthSq);
  return [x * inv, y * inv, z * inv];
}

export function validateFiniteMatrix(m: Mat4): Mat4 {
  if (!isFiniteMat4(m)) throw fbxError("FBX_TRANSFORM_INVALID");
  return m;
}
