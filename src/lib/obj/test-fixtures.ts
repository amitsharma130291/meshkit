/**
 * Deterministic OBJ text fixtures used only by tests — never imported by
 * app code. OBJ is plain text, so unlike the STL/3MF fixture builders
 * there's no binary layout to construct; these are just readable helpers
 * for assembling small, purpose-built `.obj` documents.
 */
import { expect } from "vitest";
import { OBJParseException, type OBJErrorCode } from "./errors";

export function buildOBJText(lines: string[]): string {
  return lines.join("\n");
}

export function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function simpleTriangleOBJ(): string {
  return buildOBJText(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]);
}

export function convexQuadOBJ(): string {
  return buildOBJText(["v 0 0 0", "v 2 0 0", "v 2 2 0", "v 0 2 0", "f 1 2 3 4"]);
}

/** A "dart"/arrowhead quad, concave at vertex 3 (reflex angle pointing inward). */
export function concaveQuadOBJ(): string {
  return buildOBJText(["v 0 0 0", "v 4 0 0", "v 2 1 0", "v 4 4 0", "f 1 2 3 4"]);
}

/** A concave "L" shaped hexagon — exercises ear clipping with more than one reflex vertex candidate. */
export function concaveLShapeOBJ(): string {
  return buildOBJText([
    "v 0 0 0",
    "v 4 0 0",
    "v 4 2 0",
    "v 2 2 0",
    "v 2 4 0",
    "v 0 4 0",
    "f 1 2 3 4 5 6",
  ]);
}

/** A self-crossing "bowtie" quad — invalid, must be rejected rather than triangulated. */
export function bowtieQuadOBJ(): string {
  return buildOBJText(["v 0 0 0", "v 4 4 0", "v 4 0 0", "v 0 4 0", "f 1 2 3 4"]);
}

export function expectOBJError(fn: () => unknown, code: OBJErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OBJParseException);
    expect((error as OBJParseException).code).toBe(code);
    return;
  }
  expect.fail(`expected function to throw ${code}`);
}
