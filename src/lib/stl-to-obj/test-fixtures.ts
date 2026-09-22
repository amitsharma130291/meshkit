/**
 * Deterministic fixtures used only by tests. Reuses
 * `src/lib/stl/test-fixtures.ts`'s binary/ASCII STL builders — this
 * converter's input is exactly what `/stl-viewer/` already parses, so
 * there's no reason for a second STL fixture format here.
 */
import { expect } from "vitest";
import { buildBinarySTLBuffer, type FixtureTriangle } from "../stl/test-fixtures";
import { STLParseException, type STLErrorCode } from "../stl/errors";
import { OBJParseException, type OBJErrorCode } from "../obj/errors";
import { STLToOBJException, type STLToOBJErrorCode } from "./errors";

export function simpleTriangleSTL(): ArrayBuffer {
  const triangle: FixtureTriangle = {
    normal: [0, 0, 1],
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  };
  return buildBinarySTLBuffer([triangle]);
}

export function twoTriangleQuadSTL(): ArrayBuffer {
  const a: FixtureTriangle = {
    normal: [0, 0, 1],
    vertices: [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
    ],
  };
  const b: FixtureTriangle = {
    normal: [0, 0, 1],
    vertices: [
      [0, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ],
  };
  return buildBinarySTLBuffer([a, b]);
}

/** A triangle with a repeated vertex — zero area, must be skipped as degenerate. */
export function degenerateTriangleSTL(): ArrayBuffer {
  const triangle: FixtureTriangle = {
    normal: [0, 0, 0],
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
  };
  return buildBinarySTLBuffer([triangle]);
}

type AnyKnownErrorCode = STLErrorCode | OBJErrorCode | STLToOBJErrorCode;

/** Asserts `fn` throws any of this pipeline's three exception types, carrying the given code. */
export function expectSTLToOBJError(fn: () => unknown, code: AnyKnownErrorCode): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof STLParseException || error instanceof OBJParseException || error instanceof STLToOBJException) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  expect.fail(`expected function to throw ${code}`);
}

export async function expectSTLToOBJErrorAsync(fn: () => Promise<unknown>, code: AnyKnownErrorCode): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof STLParseException || error instanceof OBJParseException || error instanceof STLToOBJException) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  expect.fail(`expected function to throw ${code}`);
}
