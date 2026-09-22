/**
 * Deterministic PLY fixture builders used only by tests — never imported
 * by app code. Builds real header text plus a matching ASCII or binary
 * body from a small, readable element/row description, so test files
 * never hand-roll raw header strings or byte layouts themselves.
 */
import { expect } from "vitest";
import { PLYParseException, type PLYErrorCode } from "./errors";
import { normalizeScalarType, scalarByteSize } from "./scalar-types";
import type { PLYFormat, PLYScalarType } from "./types";

export interface PLYPropertyDesc {
  kind: "scalar" | "list";
  /** Scalar-only: the header type token, e.g. "float", "uchar", "int32". */
  type?: string;
  /** List-only: the per-row length-prefix type token. */
  countType?: string;
  /** List-only: the item type token. */
  itemType?: string;
  name: string;
}

export interface PLYElementDesc {
  name: string;
  count: number;
  properties: PLYPropertyDesc[];
  /** One entry per row; one value per property, in declared order — a plain number for a scalar property, a number array for a list property. */
  rows: (number | number[])[][];
}

export interface BuildPLYOptions {
  format: PLYFormat;
  elements: PLYElementDesc[];
  comments?: string[];
  /** Overrides the generated header lines entirely, for malformed-header tests. */
  headerLines?: string[];
}

function propertyLine(p: PLYPropertyDesc): string {
  return p.kind === "list" ? `property list ${p.countType} ${p.itemType} ${p.name}` : `property ${p.type} ${p.name}`;
}

function buildHeaderLines(options: BuildPLYOptions): string[] {
  const lines = ["ply", `format ${options.format} 1.0`];
  for (const comment of options.comments ?? []) lines.push(`comment ${comment}`);
  for (const element of options.elements) {
    lines.push(`element ${element.name} ${element.count}`);
    for (const property of element.properties) lines.push(propertyLine(property));
  }
  lines.push("end_header");
  return lines;
}

function buildAsciiBody(elements: PLYElementDesc[]): string {
  const lines: string[] = [];
  for (const element of elements) {
    for (const row of element.rows) {
      const tokens: string[] = [];
      element.properties.forEach((property, i) => {
        const value = row[i];
        if (property.kind === "list") {
          const items = value as number[];
          tokens.push(String(items.length), ...items.map(String));
        } else {
          tokens.push(String(value));
        }
      });
      lines.push(tokens.join(" "));
    }
  }
  return lines.join("\n");
}

function writeScalarBytes(type: PLYScalarType, value: number, littleEndian: boolean): Uint8Array {
  const buffer = new ArrayBuffer(scalarByteSize(type));
  const view = new DataView(buffer);
  switch (type) {
    case "int8":
      view.setInt8(0, value);
      break;
    case "uint8":
      view.setUint8(0, value);
      break;
    case "int16":
      view.setInt16(0, value, littleEndian);
      break;
    case "uint16":
      view.setUint16(0, value, littleEndian);
      break;
    case "int32":
      view.setInt32(0, value, littleEndian);
      break;
    case "uint32":
      view.setUint32(0, value, littleEndian);
      break;
    case "float32":
      view.setFloat32(0, value, littleEndian);
      break;
    case "float64":
      view.setFloat64(0, value, littleEndian);
      break;
  }
  return new Uint8Array(buffer);
}

function buildBinaryBody(elements: PLYElementDesc[], littleEndian: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const element of elements) {
    for (const row of element.rows) {
      element.properties.forEach((property, i) => {
        const value = row[i];
        if (property.kind === "list") {
          const items = value as number[];
          const countType = normalizeScalarType(property.countType!)!;
          const itemType = normalizeScalarType(property.itemType!)!;
          chunks.push(writeScalarBytes(countType, items.length, littleEndian));
          for (const item of items) chunks.push(writeScalarBytes(itemType, item, littleEndian));
        } else {
          const type = normalizeScalarType(property.type!)!;
          chunks.push(writeScalarBytes(type, value as number, littleEndian));
        }
      });
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Builds a real PLY `ArrayBuffer`: header text (as generated from `elements`, or `headerLines` verbatim) followed by a matching ASCII or binary body. */
export function buildPLY(options: BuildPLYOptions): ArrayBuffer {
  const headerLines = options.headerLines ?? buildHeaderLines(options);
  const headerBytes = new TextEncoder().encode(headerLines.join("\n") + "\n");

  const bodyBytes =
    options.format === "ascii"
      ? new TextEncoder().encode(buildAsciiBody(options.elements))
      : buildBinaryBody(options.elements, options.format === "binary_little_endian");

  const combined = new Uint8Array(headerBytes.length + bodyBytes.length);
  combined.set(headerBytes, 0);
  combined.set(bodyBytes, headerBytes.length);
  return combined.buffer;
}

export function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// --- Common fixtures -----------------------------------------------------

export function simpleTriangleVertexElement(): PLYElementDesc {
  return {
    name: "vertex",
    count: 3,
    properties: [
      { kind: "scalar", type: "float", name: "x" },
      { kind: "scalar", type: "float", name: "y" },
      { kind: "scalar", type: "float", name: "z" },
    ],
    rows: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  };
}

export function simpleTriangleFaceElement(): PLYElementDesc {
  return {
    name: "face",
    count: 1,
    properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
    rows: [[[0, 1, 2]]],
  };
}

export function simpleTrianglePLY(format: PLYFormat = "ascii"): ArrayBuffer {
  return buildPLY({ format, elements: [simpleTriangleVertexElement(), simpleTriangleFaceElement()] });
}

export function convexQuadFaceElement(): PLYElementDesc {
  return {
    name: "face",
    count: 1,
    properties: [{ kind: "list", countType: "uchar", itemType: "int", name: "vertex_indices" }],
    rows: [[[0, 1, 2, 3]]],
  };
}

export function convexQuadPLY(format: PLYFormat = "ascii"): ArrayBuffer {
  const vertex: PLYElementDesc = {
    name: "vertex",
    count: 4,
    properties: [
      { kind: "scalar", type: "float", name: "x" },
      { kind: "scalar", type: "float", name: "y" },
      { kind: "scalar", type: "float", name: "z" },
    ],
    rows: [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ],
  };
  return buildPLY({ format, elements: [vertex, convexQuadFaceElement()] });
}

/** No face element at all — a pure point cloud, which this converter must reject rather than synthesize a surface for. */
export function pointCloudPLY(format: PLYFormat = "ascii"): ArrayBuffer {
  return buildPLY({ format, elements: [simpleTriangleVertexElement()] });
}

export function expectPLYError(fn: () => unknown, code: PLYErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PLYParseException);
    expect((error as PLYParseException).code).toBe(code);
    return;
  }
  expect.fail(`expected function to throw ${code}`);
}
