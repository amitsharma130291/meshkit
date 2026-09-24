import { stlError } from "./errors";
import { resolveNormals } from "./normals";

export interface BinarySTLInput {
  /** Flat [x,y,z, x,y,z, x,y,z, ...], 9 floats per triangle — must be a whole number of triangles. */
  positions: Float32Array;
  /** Same layout as `positions`. When omitted (or mismatched in length), normals are computed from the triangle vertices. */
  normals?: Float32Array;
  /** Free-form text for the 80-byte header. Sanitized to printable ASCII and truncated — never embed unsanitized user input here. */
  header?: string;
}

const HEADER_BYTES = 80;
const RECORD_BYTES = 50;
const MAX_TRIANGLE_COUNT = 0xffffffff; // STL's triangle count field is an unsigned 32-bit int

/**
 * The exact inverse of parse-binary.ts's byte layout: 80-byte header,
 * little-endian uint32 triangle count, then per triangle a 50-byte record
 * (3×float32 normal, 3×3×float32 vertices, uint16 attribute byte count).
 * Produces a transferable ArrayBuffer suitable for `postMessage(..., [buffer])`.
 */
export function serializeBinarySTL(input: BinarySTLInput): ArrayBuffer {
  const { positions } = input;

  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw stlError("STL_SERIALIZATION_FAILED");
  }
  const triangleCount = positions.length / 9;
  if (triangleCount > MAX_TRIANGLE_COUNT) {
    throw stlError("STL_SERIALIZATION_FAILED");
  }

  const normals =
    input.normals && input.normals.length === positions.length
      ? input.normals
      : resolveNormals(positions, new Float32Array(positions.length)); // all-zero raw normals forces a computed normal for every triangle

  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i]) || !Number.isFinite(normals[i])) {
      throw stlError("STL_SERIALIZATION_FAILED");
    }
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangleCount * RECORD_BYTES);
  const view = new DataView(buffer);

  writeHeader(buffer, input.header);
  view.setUint32(HEADER_BYTES, triangleCount, true);

  let offset = HEADER_BYTES + 4;
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 9;
    view.setFloat32(offset, normals[base], true);
    view.setFloat32(offset + 4, normals[base + 1], true);
    view.setFloat32(offset + 8, normals[base + 2], true);

    let vertexOffset = offset + 12;
    for (let v = 0; v < 3; v++) {
      const vi = base + v * 3;
      view.setFloat32(vertexOffset, positions[vi], true);
      view.setFloat32(vertexOffset + 4, positions[vi + 1], true);
      view.setFloat32(vertexOffset + 8, positions[vi + 2], true);
      vertexOffset += 12;
    }

    view.setUint16(offset + 48, 0, true); // attribute byte count — unused
    offset += RECORD_BYTES;
  }

  return buffer;
}

function writeHeader(buffer: ArrayBuffer, header: string | undefined): void {
  const safe = (header ?? "MeshWrench STL export").replace(/[^\x20-\x7e]/g, " ").slice(0, HEADER_BYTES);
  const bytes = new TextEncoder().encode(safe).slice(0, HEADER_BYTES);
  new Uint8Array(buffer, 0, HEADER_BYTES).set(bytes);
}
