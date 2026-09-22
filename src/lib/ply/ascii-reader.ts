/**
 * ASCII-body token stream. PLY's ASCII encoding conventionally puts one
 * element row per physical line, but this reader deliberately doesn't
 * enforce that — it flattens the whole body into one whitespace-separated
 * token stream and lets the header's own element/property schema dictate
 * how many tokens each row consumes. This is more lenient than the strict
 * one-row-per-line reading some PLY writers assume, and it means a stray
 * extra newline (or a row wrapped across two physical lines) never causes
 * a spurious rejection — the only way this reader fails is genuinely
 * running out of tokens before the schema is satisfied.
 */
import { plyError } from "./errors";
import { parseAsciiScalar } from "./scalar-types";
import type { ScalarReader } from "./scalar-reader";
import type { PLYScalarType } from "./types";

export function tokenizeAsciiBody(buffer: ArrayBuffer, bodyOffset: number): string[] {
  const bytes = new Uint8Array(buffer, bodyOffset);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export function createAsciiScalarReader(tokens: string[]): ScalarReader {
  let index = 0;
  return {
    // `type` is part of the `ScalarReader` interface (the binary reader needs it to pick a byte width)
    // but every ASCII token is just a plain numeric literal regardless of its declared type.
    next(_type: PLYScalarType): number {
      if (index >= tokens.length) throw plyError("PLY_BODY_TRUNCATED");
      const value = parseAsciiScalar(tokens[index++]);
      if (!Number.isFinite(value)) throw plyError("PLY_ASCII_VALUE_INVALID");
      return value;
    },
  };
}
