/**
 * Deterministic GLB fixture builders used only by tests — never imported
 * by app code. Builds real, spec-compliant GLB binaries (12-byte header +
 * padded JSON chunk + padded BIN chunk) from small, readable descriptions,
 * so test files never hand-roll raw byte arrays themselves.
 */
import { expect } from "vitest";
import { GLBParseException, type GLBErrorCode } from "./errors";

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

export interface RawChunk {
  type: number;
  data: Uint8Array;
}

export interface BuildGLBOptions {
  /** Override the whole chunk sequence for malformed-container tests. When omitted, one JSON chunk (and one BIN chunk if `bin` is given) is built normally. */
  chunks?: RawChunk[];
  json?: unknown;
  bin?: Uint8Array;
  magic?: number;
  version?: number;
  /** Override the header's declared total length instead of the real one — for GLB_LENGTH_INVALID tests. */
  declaredLength?: number;
  /** Appends extra raw bytes after the last chunk without updating the declared length's accounting — for trailing-bytes tests (paired with a real `declaredLength` matching only the chunks, not the trailer). */
  trailingBytes?: number;
}

function padTo4(bytes: Uint8Array, padByte: number): Uint8Array {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (4 - remainder));
  padded.set(bytes);
  padded.fill(padByte, bytes.length);
  return padded;
}

export function jsonChunk(json: unknown): RawChunk {
  return { type: CHUNK_TYPE_JSON, data: padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20) };
}

export function binChunk(bytes: Uint8Array): RawChunk {
  return { type: CHUNK_TYPE_BIN, data: padTo4(bytes, 0x00) };
}

/** Builds a real GLB `ArrayBuffer`. Pass `chunks` directly for tests that need a specific (possibly invalid) chunk sequence; otherwise `json`/`bin` build the normal one-or-two-chunk layout. */
export function buildGLB(options: BuildGLBOptions): ArrayBuffer {
  const chunks = options.chunks ?? [jsonChunk(options.json ?? { asset: { version: "2.0" } }), ...(options.bin ? [binChunk(options.bin)] : [])];

  let chunkBytes = 8 * chunks.length;
  for (const c of chunks) chunkBytes += c.data.length;
  const trailing = options.trailingBytes ?? 0;
  const realLength = 12 + chunkBytes + trailing;

  const buffer = new ArrayBuffer(realLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, options.magic ?? GLB_MAGIC, true);
  view.setUint32(4, options.version ?? 2, true);
  view.setUint32(8, options.declaredLength ?? realLength, true);

  let offset = 12;
  for (const c of chunks) {
    view.setUint32(offset, c.data.length, true);
    view.setUint32(offset + 4, c.type, true);
    bytes.set(c.data, offset + 8);
    offset += 8 + c.data.length;
  }

  return buffer;
}

// --- Buffer/bufferView/accessor helpers -----------------------------------

export interface PackedBuffer {
  bin: Uint8Array;
  bufferViews: { buffer: 0; byteOffset: number; byteLength: number; byteStride?: number }[];
}

/** Concatenates several typed-array payloads into one BIN chunk, returning each one's bufferView descriptor (4-byte aligned). */
export function packBufferViews(parts: { bytes: Uint8Array; byteStride?: number }[]): PackedBuffer {
  const aligned = parts.map((p) => padTo4(p.bytes, 0));
  const totalLength = aligned.reduce((sum, b) => sum + b.length, 0);
  const bin = new Uint8Array(totalLength);
  const bufferViews: PackedBuffer["bufferViews"] = [];
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    bin.set(aligned[i], offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: parts[i].bytes.length, byteStride: parts[i].byteStride });
    offset += aligned[i].length;
  }
  return { bin, bufferViews };
}

export function f32(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}
export function u32(values: number[]): Uint8Array {
  return new Uint8Array(Uint32Array.from(values).buffer);
}
export function u16(values: number[]): Uint8Array {
  return new Uint8Array(Uint16Array.from(values).buffer);
}
export function u8(values: number[]): Uint8Array {
  return new Uint8Array(Uint8Array.from(values).buffer);
}

// --- Whole-document scene builders ------------------------------------

export interface SimpleMeshOptions {
  positions: number[]; // flat xyz
  indices?: number[];
  indexComponentType?: 5121 | 5123 | 5125;
  mode?: number;
  /** Applied to the single node instantiating this mesh. */
  nodeTransform?: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] };
  extraNodeFields?: Record<string, unknown>;
}

/** One mesh, one primitive, one node, one scene — the common case most tests need. */
export function buildSimpleMeshGLB(options: SimpleMeshOptions): ArrayBuffer {
  const parts: { bytes: Uint8Array }[] = [{ bytes: f32(options.positions) }];
  const indexComponentType = options.indexComponentType ?? 5123;
  if (options.indices) {
    parts.push({
      bytes: indexComponentType === 5121 ? u8(options.indices) : indexComponentType === 5125 ? u32(options.indices) : u16(options.indices),
    });
  }
  const { bin, bufferViews } = packBufferViews(parts);

  const accessors: unknown[] = [
    { bufferView: 0, componentType: 5126, count: options.positions.length / 3, type: "VEC3" },
  ];
  if (options.indices) {
    accessors.push({ bufferView: 1, componentType: indexComponentType, count: options.indices.length, type: "SCALAR" });
  }

  const primitive: Record<string, unknown> = {
    attributes: { POSITION: 0 },
    mode: options.mode ?? 4,
  };
  if (options.indices) primitive.indices = 1;

  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...options.nodeTransform, ...options.extraNodeFields }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };

  return buildGLB({ json, bin });
}

export function simpleTriangleGLB(): ArrayBuffer {
  return buildSimpleMeshGLB({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
}

export function indexedTriangleGLB(): ArrayBuffer {
  return buildSimpleMeshGLB({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] });
}

export function expectGLBError(fn: () => unknown, code: GLBErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GLBParseException);
    expect((error as GLBParseException).code).toBe(code);
    return;
  }
  expect.fail(`expected function to throw ${code}`);
}
