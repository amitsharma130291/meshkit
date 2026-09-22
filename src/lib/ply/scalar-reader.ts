/**
 * A `ScalarReader` abstracts over ASCII and binary PLY bodies behind one
 * interface, so `parser.ts` can walk the header's element/property schema
 * exactly once, in exactly one shape, regardless of encoding. This is also
 * what makes safe skipping possible: reading (or skipping) a property
 * always means calling `next()`/`readListValues()`/`skipProperty()` the
 * same number of times a row's schema calls for, so the underlying
 * token/byte cursor never desyncs even for an element or property this
 * converter doesn't otherwise care about.
 */
import { plyError } from "./errors";
import type { PLYLimits, PLYListProperty, PLYProperty, PLYScalarType } from "./types";

export interface ScalarReader {
  next(type: PLYScalarType): number;
}

export function readListValues(property: PLYListProperty, reader: ScalarReader, limits: PLYLimits): number[] {
  const count = reader.next(property.countType);
  if (!Number.isInteger(count) || count < 0 || count > limits.maxListCount) {
    throw plyError("PLY_LIST_LENGTH_INVALID");
  }
  const values: number[] = new Array(count);
  for (let i = 0; i < count; i++) values[i] = reader.next(property.itemType);
  return values;
}

/** Reads (and discards) one property's value(s), preserving cursor alignment for a property this converter doesn't use. */
export function skipProperty(property: PLYProperty, reader: ScalarReader, limits: PLYLimits): void {
  if (property.kind === "scalar") {
    reader.next(property.type);
    return;
  }
  readListValues(property, reader, limits);
}
