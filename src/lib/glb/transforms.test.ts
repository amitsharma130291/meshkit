import { describe, expect, it } from "vitest";
import {
  composeTRS,
  determinantSign3x3,
  IDENTITY_MAT4,
  multiplyMat4,
  quaternionToMat4,
  scaleMat4,
  transformPoint,
  translationMat4,
} from "./transforms";
import { expectGLBError } from "./test-fixtures";
import type { Mat4 } from "./types";

function close(actual: readonly number[], expected: readonly number[], precision = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], precision);
  }
}

describe("translationMat4 / scaleMat4", () => {
  it("places translation in the matrix's last column (column-major layout)", () => {
    const m = translationMat4([1, 2, 3]);
    expect([m[12], m[13], m[14]]).toEqual([1, 2, 3]);
    expect(transformPoint(m, [0, 0, 0])).toEqual([1, 2, 3]);
  });

  it("scales each axis independently", () => {
    const m = scaleMat4([2, 3, 4]);
    close(transformPoint(m, [1, 1, 1]), [2, 3, 4]);
  });
});

describe("quaternionToMat4", () => {
  it("a 90-degree rotation about Z maps +X to +Y", () => {
    const halfAngle = Math.PI / 4;
    const q: [number, number, number, number] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
    const m = quaternionToMat4(q);
    close(transformPoint(m, [1, 0, 0]), [0, 1, 0]);
  });

  it("rejects a zero-length quaternion", () => {
    expectGLBError(() => quaternionToMat4([0, 0, 0, 0]), "GLB_TRANSFORM_INVALID");
  });

  it("catches quaternion component-order mistakes: x/y/z/w must not be interchangeable", () => {
    // A 90-degree rotation about X (not Z) must NOT map +X to +Y.
    const halfAngle = Math.PI / 4;
    const qAboutX: [number, number, number, number] = [Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)];
    const result = transformPoint(quaternionToMat4(qAboutX), [1, 0, 0]);
    expect(result[1]).toBeCloseTo(0, 5); // rotating about X doesn't move a point already on the X axis
  });
});

describe("multiplyMat4 / composeTRS — column-major, TRS order, parent-child order", () => {
  it("multiplying by identity is a no-op", () => {
    const m = translationMat4([1, 2, 3]);
    close(multiplyMat4(m, IDENTITY_MAT4) as unknown as number[], m as unknown as number[]);
    close(multiplyMat4(IDENTITY_MAT4, m) as unknown as number[], m as unknown as number[]);
  });

  it("composeTRS applies scale, then rotation, then translation (T × R × S) — order matters", () => {
    // Scale by 2 on X, then translate by [10,0,0]: a point at [1,0,0]
    // should land at [12,0,0] (scaled first, THEN translated), not [22,0,0]
    // (which would mean translate-then-scale, the wrong order).
    const m = composeTRS([10, 0, 0], [0, 0, 0, 1], [2, 1, 1]);
    close(transformPoint(m, [1, 0, 0]), [12, 0, 0]);
  });

  it("translate-then-scale composed manually differs from composeTRS's scale-then-translate", () => {
    const trsResult = transformPoint(composeTRS([10, 0, 0], [0, 0, 0, 1], [2, 1, 1]), [1, 0, 0]);
    const wrongOrder = transformPoint(multiplyMat4(scaleMat4([2, 1, 1]), translationMat4([10, 0, 0])), [1, 0, 0]);
    expect(trsResult).not.toEqual(wrongOrder);
  });

  it("parent-then-child composition order: multiplyMat4(parentWorld, local) applies local first", () => {
    const parent = translationMat4([100, 0, 0]);
    const local = translationMat4([1, 0, 0]);
    const world = multiplyMat4(parent, local);
    // A point at the local origin should land at parent-translation + local-translation.
    close(transformPoint(world, [0, 0, 0]), [101, 0, 0]);
  });

  it("reversing parent/child order produces a different result for non-commuting transforms", () => {
    const parent = composeTRS([0, 0, 0], [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)], [1, 1, 1]); // 90° about Z
    const local = translationMat4([1, 0, 0]);
    const correctOrder = transformPoint(multiplyMat4(parent, local), [0, 0, 0]);
    const reversedOrder = transformPoint(multiplyMat4(local, parent), [0, 0, 0]);
    expect(correctOrder).not.toEqual(reversedOrder);
  });

  it("chaining three transforms one at a time matches composing them all at once", () => {
    const a = translationMat4([1, 0, 0]);
    const b = scaleMat4([2, 2, 2]);
    const c = composeTRS([0, 0, 5], [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)], [1, 1, 1]);

    const point: [number, number, number] = [1, 1, 1];
    const stepByStep = transformPoint(c, transformPoint(b, transformPoint(a, point)));
    const composed = multiplyMat4(c, multiplyMat4(b, a));
    close(transformPoint(composed, point), stepByStep);
  });
});

describe("determinantSign3x3", () => {
  it("is positive for identity", () => {
    expect(determinantSign3x3(IDENTITY_MAT4)).toBe(1);
  });

  it("is negative for a single-axis mirror (reflection)", () => {
    const mirrorX = scaleMat4([-1, 1, 1]);
    expect(determinantSign3x3(mirrorX)).toBe(-1);
  });

  it("is positive again for a double mirror (two reflections cancel)", () => {
    const doubleMirror = scaleMat4([-1, -1, 1]);
    expect(determinantSign3x3(doubleMirror)).toBe(1);
  });
});

describe("winding correction after reflection", () => {
  function triangleWindingSign(m: Mat4, a: [number, number, number], b: [number, number, number], c: [number, number, number]): number {
    const [ax, ay, az] = transformPoint(m, a);
    const [bx, by, bz] = transformPoint(m, b);
    const [cx, cy, cz] = transformPoint(m, c);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nz = ux * vy - uy * vx;
    void uz;
    void vz;
    return Math.sign(nz);
  }

  it("a mirrored transform flips the naive triangle winding, confirming the swap-two-vertices fix is necessary", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    const c: [number, number, number] = [0, 1, 0];
    const identitySign = triangleWindingSign(IDENTITY_MAT4, a, b, c);
    const mirroredSign = triangleWindingSign(scaleMat4([-1, 1, 1]), a, b, c);
    expect(mirroredSign).toBe(-identitySign);

    // Swapping two vertices (the fix resolve-scene.ts applies) restores the original sign.
    const correctedSign = triangleWindingSign(scaleMat4([-1, 1, 1]), a, c, b);
    expect(correctedSign).toBe(identitySign);
  });
});
