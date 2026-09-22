/**
 * PLY scalar type name normalization and byte-level reading. The format
 * allows both the original Stanford names (`char`, `uchar`, `short`,
 * `ushort`, `int`, `uint`, `float`, `double`) and the more common
 * explicit-width aliases (`int8`, `uint8`, `int16`, `uint16`, `int32`,
 * `uint32`, `float32`, `float64`) interchangeably — every reader/writer in
 * this module works against the single normalized `PLYScalarType` union
 * from `types.ts`, never the raw header token.
 */
import type { PLYScalarType } from "./types";

const SCALAR_TYPE_ALIASES: Record<string, PLYScalarType> = {
  char: "int8",
  int8: "int8",
  uchar: "uint8",
  uint8: "uint8",
  short: "int16",
  int16: "int16",
  ushort: "uint16",
  uint16: "uint16",
  int: "int32",
  int32: "int32",
  uint: "uint32",
  uint32: "uint32",
  float: "float32",
  float32: "float32",
  double: "float64",
  float64: "float64",
};

export function normalizeScalarType(token: string): PLYScalarType | null {
  return SCALAR_TYPE_ALIASES[token] ?? null;
}

export function isIntegerScalarType(type: PLYScalarType): boolean {
  return type !== "float32" && type !== "float64";
}

const BYTE_SIZES: Record<PLYScalarType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

export function scalarByteSize(type: PLYScalarType): number {
  return BYTE_SIZES[type];
}

/** Reads one value of `type` from `view` at `offset`, in the given byte order. */
export function readScalar(view: DataView, offset: number, type: PLYScalarType, littleEndian: boolean): number {
  switch (type) {
    case "int8":
      return view.getInt8(offset);
    case "uint8":
      return view.getUint8(offset);
    case "int16":
      return view.getInt16(offset, littleEndian);
    case "uint16":
      return view.getUint16(offset, littleEndian);
    case "int32":
      return view.getInt32(offset, littleEndian);
    case "uint32":
      return view.getUint32(offset, littleEndian);
    case "float32":
      return view.getFloat32(offset, littleEndian);
    case "float64":
      return view.getFloat64(offset, littleEndian);
  }
}

/** Parses one ASCII token as `type`. Integer types are still read with `Number()` — PLY's ASCII grammar is a plain numeric literal regardless of the declared type — and validated for finiteness by the caller. */
export function parseAsciiScalar(token: string): number {
  return Number(token);
}
