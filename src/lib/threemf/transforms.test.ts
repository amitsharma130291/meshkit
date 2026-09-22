import { describe, expect, it } from "vitest";
import { ThreeMFParseException } from "./errors";
import {
  applyTransform,
  composeTransforms,
  IDENTITY_TRANSFORM,
  parseTransform,
  transformDeterminantSign,
} from "./transforms";
import type { ThreeMFTransform } from "./types";

function expectClose(actual: readonly number[], expected: readonly number[], precision = 6): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], precision);
  }
}

describe("parseTransform", () => {
  it("parses 12 space-separated numbers", () => {
    const t = parseTransform("1 0 0 0 1 0 0 0 1 5 6 7");
    expect(t).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
  });

  it("rejects a transform without exactly 12 numbers", () => {
    expect(() => parseTransform("1 0 0 0 1 0 0 0 1")).toThrow(ThreeMFParseException);
  });

  it("rejects non-finite values", () => {
    expect(() => parseTransform("1 0 0 0 1 0 0 0 1 NaN 0 0")).toThrow(ThreeMFParseException);
  });
});

describe("applyTransform — basic cases", () => {
  it("identity leaves a point unchanged", () => {
    expectClose(applyTransform(IDENTITY_TRANSFORM, 3, 4, 5), [3, 4, 5]);
  });

  it("pure translation", () => {
    const t: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30];
    expectClose(applyTransform(t, 1, 2, 3), [11, 22, 33]);
  });

  it("90-degree rotation about Z", () => {
    // Rotating +X by 90° about Z should land on +Y.
    const cos = 0;
    const sin = 1;
    const t: ThreeMFTransform = [cos, sin, 0, -sin, cos, 0, 0, 0, 1, 0, 0, 0];
    expectClose(applyTransform(t, 1, 0, 0), [0, 1, 0]);
  });

  it("uniform scaling", () => {
    const t: ThreeMFTransform = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
    expectClose(applyTransform(t, 1, 2, 3), [2, 4, 6]);
  });

  it("non-uniform scaling", () => {
    const t: ThreeMFTransform = [2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0];
    expectClose(applyTransform(t, 1, 1, 1), [2, 3, 4]);
  });

  it("combined scale + translate", () => {
    const t: ThreeMFTransform = [2, 0, 0, 0, 2, 0, 0, 0, 2, 1, 1, 1];
    expectClose(applyTransform(t, 1, 1, 1), [3, 3, 3]);
  });
});

describe("composeTransforms — row/column-major sanity", () => {
  it("composing with identity on either side is a no-op", () => {
    const t: ThreeMFTransform = [2, 0, 0, 0, 3, 0, 0, 0, 4, 5, 6, 7];
    expectClose(composeTransforms(IDENTITY_TRANSFORM, t), t);
    expectClose(composeTransforms(t, IDENTITY_TRANSFORM), t);
  });

  it("applies the inner transform first, then the outer — translate-then-scale differs from scale-then-translate", () => {
    const translate: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
    const scale: ThreeMFTransform = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];

    // inner=translate, outer=scale: point is translated first (x+10), then scaled by 2 -> (x+10)*2
    const translateThenScale = composeTransforms(translate, scale);
    expectClose(applyTransform(translateThenScale, 0, 0, 0), [20, 0, 0]);

    // inner=scale, outer=translate: point is scaled first (x*2), then translated by 10 -> x*2+10
    const scaleThenTranslate = composeTransforms(scale, translate);
    expectClose(applyTransform(scaleThenTranslate, 0, 0, 0), [10, 0, 0]);
  });

  it("composing a transform with itself matches applying it twice", () => {
    const t: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 0, 0]; // translate +3 on x
    const twice = composeTransforms(t, t);
    const [x] = applyTransform(twice, 0, 0, 0);
    expect(x).toBeCloseTo(6, 10);
  });

  it("nested composition (component -> component -> build item) matches manual sequential application", () => {
    const a: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]; // +1 x
    const b: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0]; // +2 y
    const c: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 3]; // +3 z

    // Apply a, then b, then c, directly to a point.
    const manual1 = applyTransform(a, 0, 0, 0);
    const manual2 = applyTransform(b, manual1[0], manual1[1], manual1[2]);
    const manual3 = applyTransform(c, manual2[0], manual2[1], manual2[2]);

    // Compose a-then-b-then-c into one transform and apply once.
    const combined = composeTransforms(composeTransforms(a, b), c);
    const composed = applyTransform(combined, 0, 0, 0);

    expectClose(composed, manual3);
    expectClose(composed, [1, 2, 3]);
  });
});

describe("transformDeterminantSign", () => {
  it("is positive for identity and pure translation/rotation/positive scaling", () => {
    expect(transformDeterminantSign(IDENTITY_TRANSFORM)).toBe(1);
    expect(transformDeterminantSign([2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0])).toBe(1);
  });

  it("is negative for a single-axis mirror (reflection)", () => {
    const mirrorX: ThreeMFTransform = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    expect(transformDeterminantSign(mirrorX)).toBe(-1);
  });

  it("is positive again for a double mirror (two reflections cancel out)", () => {
    const mirrorXY: ThreeMFTransform = [-1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0];
    expect(transformDeterminantSign(mirrorXY)).toBe(1);
  });

  it("is zero for a degenerate (fully flattened) transform", () => {
    const flatten: ThreeMFTransform = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    expect(transformDeterminantSign(flatten)).toBe(0);
  });
});
