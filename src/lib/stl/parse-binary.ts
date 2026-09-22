import { BINARY_HEADER_BYTES, BINARY_TRIANGLE_RECORD_BYTES } from "./detect";
import { stlError } from "./errors";
import type { STLParseLimits } from "./types";

export interface RawSTLGeometry {
  triangleCount: number;
  positions: Float32Array;
  /** Raw per-triangle normal, broadcast to all 3 vertices. May be zero/garbage — see parse.ts's resolveNormals. */
  normals: Float32Array;
  header?: string;
}

/**
 * Parses a binary STL buffer. Every allocation is preceded by a validation
 * step so a hostile or corrupted `triangleCount` can never cause an
 * out-of-bounds read or an unbounded allocation.
 */
export function parseBinarySTL(buffer: ArrayBuffer, limits: STLParseLimits): RawSTLGeometry {
  if (buffer.byteLength < BINARY_HEADER_BYTES + 4) {
    throw stlError("STL_BINARY_TRUNCATED");
  }

  const view = new DataView(buffer);
  const header = decodeHeader(buffer);
  const triangleCount = view.getUint32(BINARY_HEADER_BYTES, true);

  if (!Number.isFinite(triangleCount) || triangleCount < 0) {
    throw stlError("STL_INVALID_TRIANGLE_COUNT");
  }
  if (triangleCount > limits.maxTriangles) {
    throw stlError("STL_TOO_COMPLEX");
  }

  const expectedLength = BINARY_HEADER_BYTES + 4 + triangleCount * BINARY_TRIANGLE_RECORD_BYTES;
  if (expectedLength > buffer.byteLength) {
    throw stlError("STL_BINARY_TRUNCATED");
  }
  if (triangleCount === 0) {
    throw stlError("STL_EMPTY_GEOMETRY");
  }

  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);

  let offset = BINARY_HEADER_BYTES + 4;
  for (let t = 0; t < triangleCount; t++) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    const hasFiniteNormal = Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz);

    const base = t * 9;
    for (let v = 0; v < 3; v++) {
      const vertexOffset = offset + 12 + v * 12;
      const x = view.getFloat32(vertexOffset, true);
      const y = view.getFloat32(vertexOffset + 4, true);
      const z = view.getFloat32(vertexOffset + 8, true);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw stlError("STL_NON_FINITE_VERTEX");
      }

      const i = base + v * 3;
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;
      normals[i] = hasFiniteNormal ? nx : 0;
      normals[i + 1] = hasFiniteNormal ? ny : 0;
      normals[i + 2] = hasFiniteNormal ? nz : 0;
    }

    // 2 attribute-byte-count bytes follow each record; not used by the viewer.
    offset += BINARY_TRIANGLE_RECORD_BYTES;
  }

  return { triangleCount, positions, normals, header };
}

function decodeHeader(buffer: ArrayBuffer): string | undefined {
  const headerBytes = new Uint8Array(buffer, 0, BINARY_HEADER_BYTES);
  const text = new TextDecoder("ascii")
    .decode(headerBytes)
    .replace(/\0+$/, "")
    .trim();
  return text.length > 0 ? text : undefined;
}
