/**
 * Decodes one binary FBX property, given a cursor already positioned at
 * its 1-byte type code. Every property type binary FBX 7.x actually uses
 * is handled here: six scalars (`Y C I F D L`), five typed-array kinds
 * (`f d l i b`, each with an uncompressed/zlib-compressed array header),
 * and two byte-blob kinds (`S` string, `R` raw). binary-parser.ts calls
 * this once per declared property in a node's property list; this module
 * never walks the node tree itself.
 */
import { unzlibSync } from "fflate";
import { fbxError } from "./errors";
import type { BinaryCursor } from "./binary-reader";
import type { FBXLimits, FBXProperty, FBXPropertyTypeCode } from "./types";

const ARRAY_ENCODING_RAW = 0;
const ARRAY_ENCODING_ZLIB = 1;

interface ArrayTypeInfo {
  elementSize: number;
  build: (bytes: Uint8Array, count: number) => FBXProperty;
}

/** `Float32Array.from(new DataView(...))`-style helpers would allocate an extra copy per element; instead each builder makes one typed array directly over (a copy of) the decoded bytes, respecting native endianness by reading through a `DataView` when the platform isn't little-endian. FBX arrays are always little-endian on disk. */
function bytesToTypedArray<T extends Float32Array | Float64Array | Int32Array | BigInt64Array>(
  bytes: Uint8Array,
  count: number,
  bytesPerElement: number,
  read: (view: DataView, byteOffset: number) => number | bigint,
  Ctor: { new (length: number): T },
): T {
  const out = new Ctor(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    (out as unknown as (number | bigint)[])[i] = read(view, i * bytesPerElement);
  }
  return out;
}

const ARRAY_TYPES: Record<"f" | "d" | "l" | "i" | "b", ArrayTypeInfo> = {
  f: {
    elementSize: 4,
    build: (bytes, count) => ({ type: "f", value: bytesToTypedArray(bytes, count, 4, (v, o) => v.getFloat32(o, true), Float32Array) }),
  },
  d: {
    elementSize: 8,
    build: (bytes, count) => ({ type: "d", value: bytesToTypedArray(bytes, count, 8, (v, o) => v.getFloat64(o, true), Float64Array) }),
  },
  l: {
    elementSize: 8,
    build: (bytes, count) => ({ type: "l", value: bytesToTypedArray(bytes, count, 8, (v, o) => v.getBigInt64(o, true), BigInt64Array) }),
  },
  i: {
    elementSize: 4,
    build: (bytes, count) => ({ type: "i", value: bytesToTypedArray(bytes, count, 4, (v, o) => v.getInt32(o, true), Int32Array) }),
  },
  b: {
    elementSize: 1,
    build: (bytes, count) => ({ type: "b", value: bytes.slice(0, count) }),
  },
};

function decodeArrayProperty(cursor: BinaryCursor, kind: "f" | "d" | "l" | "i" | "b", limits: FBXLimits): FBXProperty {
  const arrayLength = cursor.readUint32LE();
  const encoding = cursor.readUint32LE();
  const compressedLength = cursor.readUint32LE();

  const info = ARRAY_TYPES[kind];
  const declaredBytes = arrayLength * info.elementSize;
  if (declaredBytes > limits.maxDecompressedArrayBytes) throw fbxError("FBX_ARRAY_TOO_LARGE");
  if (compressedLength > limits.maxCompressedArrayBytes) throw fbxError("FBX_ARRAY_COMPRESSED_TOO_LARGE");

  const payload = cursor.readBytes(compressedLength);

  let raw: Uint8Array;
  if (encoding === ARRAY_ENCODING_RAW) {
    if (payload.byteLength !== declaredBytes) throw fbxError("FBX_ARRAY_DECOMPRESSION_FAILED");
    raw = payload;
  } else if (encoding === ARRAY_ENCODING_ZLIB) {
    try {
      raw = unzlibSync(payload, { out: new Uint8Array(declaredBytes) });
    } catch {
      throw fbxError("FBX_ARRAY_DECOMPRESSION_FAILED");
    }
    if (raw.byteLength !== declaredBytes) throw fbxError("FBX_ARRAY_DECOMPRESSION_FAILED");
  } else {
    throw fbxError("FBX_PROPERTY_INVALID");
  }

  return info.build(raw, arrayLength);
}

export function decodeProperty(cursor: BinaryCursor, limits: FBXLimits): FBXProperty {
  const typeCode = String.fromCharCode(cursor.readUint8()) as FBXPropertyTypeCode;

  switch (typeCode) {
    case "Y":
      return { type: "Y", value: cursor.readInt16LE() };
    case "C":
      return { type: "C", value: cursor.readUint8() !== 0 };
    case "I":
      return { type: "I", value: cursor.readInt32LE() };
    case "F":
      return { type: "F", value: cursor.readFloat32LE() };
    case "D":
      return { type: "D", value: cursor.readFloat64LE() };
    case "L":
      return { type: "L", value: cursor.readBigInt64LE() };
    case "f":
    case "d":
    case "l":
    case "i":
    case "b":
      return decodeArrayProperty(cursor, typeCode, limits);
    case "S": {
      const length = cursor.readUint32LE();
      return { type: "S", value: cursor.readString(length, limits.maxStringBytes) };
    }
    case "R": {
      const length = cursor.readUint32LE();
      if (length > limits.maxRawPropertyBytes) throw fbxError("FBX_RAW_PROPERTY_TOO_LARGE");
      return { type: "R", value: cursor.readBytes(length).slice() };
    }
    default:
      throw fbxError("FBX_PROPERTY_INVALID");
  }
}
