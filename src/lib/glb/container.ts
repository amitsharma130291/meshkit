/**
 * GLB (glTF Binary Container, version 2) framing: a 12-byte header
 * followed by one or more 4-byte-aligned chunks. Every offset and length
 * here is validated against the actual buffer size before it's trusted —
 * nothing downstream (schema.ts, accessors.ts) re-derives these bounds.
 */
import { glbError } from "./errors";
import type { GLBLimits } from "./types";

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0"

export interface GLBContainer {
  /** Raw JSON chunk bytes (may include glTF-mandated trailing space padding) — still needs UTF-8 decode + JSON.parse. */
  json: Uint8Array;
  /** Raw embedded binary chunk, or null when the file has no BIN chunk. */
  bin: Uint8Array | null;
}

export function parseGLBContainer(buffer: ArrayBuffer, limits: GLBLimits): GLBContainer {
  if (buffer.byteLength > limits.maxContainerBytes) {
    throw glbError("GLB_FILE_TOO_LARGE");
  }
  if (buffer.byteLength < HEADER_BYTES) {
    throw glbError("GLB_HEADER_TRUNCATED");
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw glbError("GLB_MAGIC_INVALID");
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    throw glbError("GLB_VERSION_UNSUPPORTED");
  }

  const declaredLength = view.getUint32(8, true);
  // Reject both "claims to be bigger than it is" and "trailing undeclared
  // bytes after what it claims" by requiring an exact match.
  if (declaredLength < HEADER_BYTES || declaredLength !== buffer.byteLength) {
    throw glbError("GLB_LENGTH_INVALID");
  }

  let offset = HEADER_BYTES;
  let json: Uint8Array | null = null;
  let bin: Uint8Array | null = null;
  let chunkIndex = 0;

  while (offset < declaredLength) {
    if (offset + CHUNK_HEADER_BYTES > declaredLength) {
      throw glbError("GLB_CHUNK_TRUNCATED");
    }

    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + CHUNK_HEADER_BYTES;

    if (chunkLength % 4 !== 0) {
      throw glbError("GLB_CHUNK_TRUNCATED"); // glTF requires every chunk padded to a 4-byte boundary
    }
    // `declaredLength - dataStart` can't underflow: dataStart <= declaredLength was just checked above.
    if (chunkLength > declaredLength - dataStart) {
      throw glbError("GLB_CHUNK_TRUNCATED");
    }

    const dataEnd = dataStart + chunkLength;
    const chunkData = bytes.subarray(dataStart, dataEnd);

    if (chunkType === CHUNK_TYPE_JSON) {
      if (chunkIndex !== 0) {
        throw glbError("GLB_CHUNK_INVALID"); // JSON must be the first chunk — including "a second JSON chunk shows up later"
      }
      if (chunkLength > limits.maxJsonBytes) {
        throw glbError("GLB_FILE_TOO_LARGE");
      }
      json = chunkData;
    } else if (chunkType === CHUNK_TYPE_BIN) {
      if (chunkIndex === 0) {
        throw glbError("GLB_JSON_CHUNK_MISSING"); // BIN can never legally be the first chunk
      }
      if (bin !== null) {
        throw glbError("GLB_CHUNK_INVALID"); // a second BIN chunk is ambiguous — which one is "the" buffer?
      }
      if (chunkLength > limits.maxBinBytes) {
        throw glbError("GLB_FILE_TOO_LARGE");
      }
      bin = chunkData;
    }
    // An unrecognized chunk type is skipped without being read — per the
    // glTF spec, clients MUST ignore chunks of an unknown type.

    offset = dataEnd;
    chunkIndex++;
  }

  if (!json) {
    throw glbError("GLB_JSON_CHUNK_MISSING");
  }

  return { json, bin };
}
