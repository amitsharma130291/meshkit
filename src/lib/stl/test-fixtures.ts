/**
 * Small, deterministic STL fixture builders used only by tests — never
 * imported by app code. Keeps every test file's fixture data readable
 * instead of hard-coding raw byte arrays repeatedly.
 */
import { expect } from "vitest";
import { STLParseException, type STLErrorCode } from "./errors";

export interface FixtureTriangle {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
}

export function sampleTriangle(): FixtureTriangle {
  return {
    normal: [0, 0, 1],
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  };
}

export function buildBinarySTLBuffer(triangles: FixtureTriangle[], header = "meshkit test fixture"): ArrayBuffer {
  const HEADER_BYTES = 80;
  const RECORD_BYTES = 50;
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles.length * RECORD_BYTES);
  const view = new DataView(buffer);

  const headerBytes = new TextEncoder().encode(header.slice(0, HEADER_BYTES));
  new Uint8Array(buffer, 0, HEADER_BYTES).set(headerBytes);
  view.setUint32(HEADER_BYTES, triangles.length, true);

  let offset = HEADER_BYTES + 4;
  for (const tri of triangles) {
    view.setFloat32(offset, tri.normal[0], true);
    view.setFloat32(offset + 4, tri.normal[1], true);
    view.setFloat32(offset + 8, tri.normal[2], true);

    let vertexOffset = offset + 12;
    for (const vertex of tri.vertices) {
      view.setFloat32(vertexOffset, vertex[0], true);
      view.setFloat32(vertexOffset + 4, vertex[1], true);
      view.setFloat32(vertexOffset + 8, vertex[2], true);
      vertexOffset += 12;
    }
    view.setUint16(offset + 48, 0, true); // attribute byte count
    offset += RECORD_BYTES;
  }

  return buffer;
}

export function buildAsciiSTLText(triangles: FixtureTriangle[], solidName = "fixture"): string {
  const lines: string[] = [`solid ${solidName}`];
  for (const tri of triangles) {
    lines.push(`  facet normal ${tri.normal.join(" ")}`);
    lines.push("    outer loop");
    for (const vertex of tri.vertices) {
      lines.push(`      vertex ${vertex.join(" ")}`);
    }
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join("\n");
}

export function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** Asserts `fn` throws an `STLParseException` with the given code. */
export function expectSTLError(fn: () => unknown, code: STLErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(STLParseException);
    expect((error as STLParseException).code).toBe(code);
    return;
  }
  expect.fail(`expected function to throw ${code}`);
}
