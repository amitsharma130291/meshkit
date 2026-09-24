import { describe, expect, it } from "vitest";
import {
  IDENTITY_MAT4,
  applyNormalMatrix,
  composeGeometricMatrix,
  composeLocalMatrix,
  computeNormalMatrix,
  determinantSign3x3,
  eulerToMat4,
  multiplyMat4,
  readNodeTransformProperties,
  scaleMat4,
  transformPoint,
  translationMat4,
  type FBXNodeTransformProperties,
} from "./transforms";

function close(actual: readonly number[], expected: readonly number[], precision = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i], precision);
}

function defaultTransform(overrides: Partial<FBXNodeTransformProperties> = {}): FBXNodeTransformProperties {
  return {
    translation: [0, 0, 0],
    rotationOffset: [0, 0, 0],
    rotationPivot: [0, 0, 0],
    preRotation: [0, 0, 0],
    rotation: [0, 0, 0],
    postRotation: [0, 0, 0],
    scalingOffset: [0, 0, 0],
    scalingPivot: [0, 0, 0],
    scaling: [1, 1, 1],
    rotationOrder: 0,
    inheritType: 0,
    geometricTranslation: [0, 0, 0],
    geometricRotation: [0, 0, 0],
    geometricScaling: [1, 1, 1],
    ...overrides,
  };
}

describe("translationMat4 / scaleMat4 / multiplyMat4 — order", () => {
  it("places translation in the matrix's last column (column-major layout)", () => {
    const m = translationMat4([1, 2, 3]);
    close(transformPoint(m, [0, 0, 0]), [1, 2, 3]);
  });

  it("multiplyMat4(a, b) applies b first, then a — reversing the order changes the result for non-commuting transforms", () => {
    const scale2x = scaleMat4([2, 1, 1]);
    const translate10 = translationMat4([10, 0, 0]);
    // scale-then-translate: point at [1,0,0] -> scaled to [2,0,0] -> translated to [12,0,0]
    const scaleFirst = transformPoint(multiplyMat4(translate10, scale2x), [1, 0, 0]);
    // translate-then-scale: point at [1,0,0] -> translated to [11,0,0] -> scaled to [22,0,0]
    const translateFirst = transformPoint(multiplyMat4(scale2x, translate10), [1, 0, 0]);
    close(scaleFirst, [12, 0, 0]);
    close(translateFirst, [22, 0, 0]);
    expect(scaleFirst).not.toEqual(translateFirst);
  });

  it("parent-then-child composition: multiplyMat4(parentWorld, local) applies local first", () => {
    const parent = translationMat4([100, 0, 0]);
    const local = translationMat4([1, 0, 0]);
    close(transformPoint(multiplyMat4(parent, local), [0, 0, 0]), [101, 0, 0]);
  });
});

describe("eulerToMat4 — degrees, not radians", () => {
  it("a 90-degree rotation about X maps +Y to +Z (would be wildly different if degrees were treated as radians)", () => {
    const m = eulerToMat4([90, 0, 0], 0);
    close(transformPoint(m, [0, 1, 0]), [0, 0, 1]);
  });

  it("a 180-degree rotation about Y maps +X to -X", () => {
    const m = eulerToMat4([0, 180, 0], 0);
    close(transformPoint(m, [1, 0, 0]), [-1, 0, 0]);
  });

  it("a tiny angle (1 degree) barely moves a point — would move it enormously if misread as 1 radian", () => {
    const m = eulerToMat4([0, 0, 1], 0);
    const [x, y] = transformPoint(m, [1, 0, 0]);
    expect(Math.abs(y)).toBeLessThan(0.02); // sin(1°) ≈ 0.0175; sin(1 rad) ≈ 0.841 would fail this
    expect(x).toBeCloseTo(1, 2);
  });
});

describe("eulerToMat4 — rotation order matters and matches the FBX SDK convention (order [A,B,C] composes as Rc·Rb·Ra)", () => {
  it("order XYZ (0) and order YXZ (3) produce different results for the same non-trivial angle triple", () => {
    const xyz = transformPoint(eulerToMat4([90, 90, 0], 0), [0, 1, 0]);
    const yxz = transformPoint(eulerToMat4([90, 90, 0], 3), [0, 1, 0]);
    expect(xyz).not.toEqual(yxz);
  });

  it("order XYZ (0) with rotation [90, 90, 0] applied to +Y matches the hand-derived Rz·Ry·Rx composition", () => {
    // Z=0 so Rz is identity: expected = Ry(90°) · Rx(90°) · [0,1,0].
    // Rx(90°)·[0,1,0] = [0,0,1]; Ry(90°)·[0,0,1] = [1,0,0] (hand-derived from the rotation-matrix definition, independent of this module's own composition code).
    close(transformPoint(eulerToMat4([90, 90, 0], 0), [0, 1, 0]), [1, 0, 0]);
  });

  it("order YXZ (3) with rotation [90, 90, 0] applied to +Y matches the hand-derived Rz·Rx·Ry composition", () => {
    // Z=0 so Rz is identity: expected = Rx(90°) · Ry(90°) · [0,1,0].
    // Ry(90°)·[0,1,0] = [0,1,0] (a vector along Y is unaffected by a Y-axis rotation); Rx(90°)·[0,1,0] = [0,0,1].
    close(transformPoint(eulerToMat4([90, 90, 0], 3), [0, 1, 0]), [0, 0, 1]);
  });
});

describe("composeLocalMatrix — post-rotation is inverted", () => {
  it("a nonzero PostRotation is applied as its inverse, not the forward rotation", () => {
    const t = defaultTransform({ postRotation: [0, 90, 0] });
    const local = composeLocalMatrix(t);
    const expectedInverse = eulerToMat4([0, -90, 0], 0); // inverse of a 90° Y rotation is a -90° Y rotation
    const wrongForward = eulerToMat4([0, 90, 0], 0);
    close(transformPoint(local, [1, 0, 0]), transformPoint(expectedInverse, [1, 0, 0]));
    expect(transformPoint(local, [1, 0, 0])).not.toEqual(transformPoint(wrongForward, [1, 0, 0]));
  });

  it("PreRotation and PostRotation always use XYZ order, independent of the node's own declared RotationOrder", () => {
    const withOrderZYX = composeLocalMatrix(defaultTransform({ preRotation: [30, 45, 60], rotationOrder: 5 }));
    const withOrderXYZ = composeLocalMatrix(defaultTransform({ preRotation: [30, 45, 60], rotationOrder: 0 }));
    // Lcl Rotation itself is zero in both cases, so RotationOrder should have NO effect at all — only PreRotation (always XYZ) contributes.
    close(transformPoint(withOrderZYX, [1, 1, 1]), transformPoint(withOrderXYZ, [1, 1, 1]));
  });
});

describe("composeLocalMatrix — pivots and offsets", () => {
  it("rotating about a non-origin RotationPivot orbits the point around that pivot, not the origin", () => {
    const t = defaultTransform({ rotationPivot: [5, 0, 0], rotation: [0, 0, 90] });
    const local = composeLocalMatrix(t);
    // A point AT the pivot should stay at the pivot after a pure rotation-about-pivot.
    close(transformPoint(local, [5, 0, 0]), [5, 0, 0], 4);
    // A point 1 unit further out along X from the pivot rotates 90° around Z about that pivot: [6,0,0] -> pivot-relative [1,0,0] -> rotated [0,1,0] -> world [5,1,0].
    close(transformPoint(local, [6, 0, 0]), [5, 1, 0], 4);
  });

  it("RotationOffset shifts the pivot's own effective position without itself being rotated", () => {
    const t = defaultTransform({ rotationOffset: [10, 0, 0], rotation: [0, 0, 90] });
    const local = composeLocalMatrix(t);
    // Offset translates first, then rotation happens about the (still-origin) pivot, so the origin orbits around the offset point.
    close(transformPoint(local, [0, 0, 0]), [10, 0, 0], 4);
  });
});

describe("composeLocalMatrix / composeGeometricMatrix — geometric transform never leaks into the local matrix", () => {
  it("composeLocalMatrix's output is identical regardless of geometric* fields", () => {
    const withoutGeometric = composeLocalMatrix(defaultTransform({ translation: [1, 2, 3], rotation: [10, 20, 30] }));
    const withGeometric = composeLocalMatrix(
      defaultTransform({ translation: [1, 2, 3], rotation: [10, 20, 30], geometricTranslation: [50, 50, 50], geometricRotation: [90, 90, 90], geometricScaling: [3, 3, 3] }),
    );
    close(withoutGeometric as unknown as number[], withGeometric as unknown as number[]);
  });

  it("composeGeometricMatrix is identity when no geometric transform is declared", () => {
    close(composeGeometricMatrix(defaultTransform()) as unknown as number[], IDENTITY_MAT4 as unknown as number[]);
  });

  it("composeGeometricMatrix reflects geometric translation/rotation/scale independently of the local transform", () => {
    const geo = composeGeometricMatrix(defaultTransform({ geometricTranslation: [5, 0, 0], geometricScaling: [2, 2, 2] }));
    // Gt · Gr · Gs applied to [1,0,0]: scaled to [2,0,0], rotated (identity), translated to [7,0,0].
    close(transformPoint(geo, [1, 0, 0]), [7, 0, 0]);
  });
});

describe("readNodeTransformProperties", () => {
  it("falls back to identity defaults when Properties70 declares nothing", () => {
    const t = readNodeTransformProperties(new Map());
    expect(t.translation).toEqual([0, 0, 0]);
    expect(t.scaling).toEqual([1, 1, 1]);
    expect(t.rotationOrder).toBe(0);
  });

  it("reads declared D-triplet and enum values", () => {
    const props = new Map<string, import("./types").FBXProperty[]>([
      ["Lcl Translation", [{ type: "D", value: 1 }, { type: "D", value: 2 }, { type: "D", value: 3 }]],
      ["RotationOrder", [{ type: "I", value: 5 }]],
    ]);
    const t = readNodeTransformProperties(props);
    expect(t.translation).toEqual([1, 2, 3]);
    expect(t.rotationOrder).toBe(5);
  });
});

describe("determinantSign3x3 — reflection detection", () => {
  it("is positive for identity and negative for a single-axis mirror", () => {
    expect(determinantSign3x3(IDENTITY_MAT4)).toBe(1);
    expect(determinantSign3x3(scaleMat4([-1, 1, 1]))).toBe(-1);
  });

  it("is positive again for a double mirror (two reflections cancel)", () => {
    expect(determinantSign3x3(scaleMat4([-1, -1, 1]))).toBe(1);
  });
});

describe("computeNormalMatrix / applyNormalMatrix — correct under non-uniform scale and reflection", () => {
  it("a uniform scale leaves a normal direction unchanged (after re-normalization)", () => {
    const m = scaleMat4([2, 2, 2]);
    const nm = computeNormalMatrix(m)!;
    close(applyNormalMatrix(nm, 0, 1, 0), [0, 1, 0]);
  });

  it("a non-uniform scale tilts a normal — the naive position transform would get this wrong", () => {
    // A 45-degree-ish normal on a surface stretched along X should tilt TOWARD the un-stretched axis, not stay diagonal.
    const m = scaleMat4([4, 1, 1]);
    const nm = computeNormalMatrix(m)!;
    const [nx, ny] = applyNormalMatrix(nm, Math.SQRT1_2, Math.SQRT1_2, 0);
    // Naively transforming the normal like a position would give [4*0.707, 0.707] normalized ≈ [0.98, 0.24] — nearly parallel to X.
    // The correct inverse-transpose result tilts the OTHER way: closer to the un-stretched Y axis.
    expect(Math.abs(ny)).toBeGreaterThan(Math.abs(nx));
  });

  it("returns null for a singular (non-invertible) linear part", () => {
    const singular = scaleMat4([0, 1, 1]);
    expect(computeNormalMatrix(singular)).toBeNull();
  });
});
