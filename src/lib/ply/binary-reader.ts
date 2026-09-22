/**
 * Binary-body byte cursor, shared by both `binary_little_endian` and
 * `binary_big_endian` — the only difference between the two is the
 * `littleEndian` flag passed to every `DataView` read, decided once from
 * the header and threaded through unchanged.
 */
import { plyError } from "./errors";
import { readScalar, scalarByteSize } from "./scalar-types";
import type { ScalarReader } from "./scalar-reader";
import type { PLYScalarType } from "./types";

export function createBinaryScalarReader(buffer: ArrayBuffer, bodyOffset: number, littleEndian: boolean): ScalarReader {
  const view = new DataView(buffer);
  let offset = bodyOffset;

  return {
    next(type: PLYScalarType): number {
      const size = scalarByteSize(type);
      if (offset + size > view.byteLength) throw plyError("PLY_BODY_TRUNCATED");
      const value = readScalar(view, offset, type, littleEndian);
      offset += size;
      return value;
    },
  };
}
