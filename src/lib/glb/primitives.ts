/**
 * Decodes every mesh's primitives ONCE, up front, into local-space
 * (untransformed) triangle geometry — independent of how many scene nodes
 * end up instancing that mesh. resolve-scene.ts then applies each node's
 * world transform to these already-decoded triangles, so a mesh shared by
 * many nodes is never re-read from its accessors more than once.
 */
import { glbError } from "./errors";
import { readIndexAccessor, readPositionAccessor } from "./accessors";
import type { DecodedMesh, DecodedPrimitive, GLBLimits, GLTFDocument, GLTFPrimitive } from "./types";

const MODE_POINTS = 0;
const MODE_LINES = 1;
const MODE_LINE_LOOP = 2;
const MODE_LINE_STRIP = 3;
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

const UNSUPPORTED_LINE_POINT_MODES: ReadonlySet<number> = new Set([MODE_POINTS, MODE_LINES, MODE_LINE_LOOP, MODE_LINE_STRIP]);
const SUPPORTED_TRIANGLE_MODES: ReadonlySet<number> = new Set([MODE_TRIANGLES, MODE_TRIANGLE_STRIP, MODE_TRIANGLE_FAN]);

export function decodeMeshes(
  doc: GLTFDocument,
  bin: Uint8Array | null,
  limits: GLBLimits,
): { meshes: DecodedMesh[]; totalVertices: number; skippedUnsupportedPrimitiveCount: number } {
  const meshes: DecodedMesh[] = [];
  let totalVertices = 0;
  let skippedUnsupportedPrimitiveCount = 0;

  for (const mesh of doc.meshes) {
    const primitives: DecodedPrimitive[] = [];

    for (const primitive of mesh.primitives) {
      if (UNSUPPORTED_LINE_POINT_MODES.has(primitive.mode)) {
        skippedUnsupportedPrimitiveCount++;
        continue;
      }
      if (!SUPPORTED_TRIANGLE_MODES.has(primitive.mode)) {
        throw glbError("GLB_PRIMITIVE_MODE_UNSUPPORTED");
      }
      if (primitive.extensions?.KHR_draco_mesh_compression !== undefined) {
        throw glbError("GLB_DRACO_UNSUPPORTED");
      }

      const decoded = decodePrimitive(doc, primitive, bin, limits);
      if (decoded) {
        totalVertices += decoded.positions.length / 3;
        if (totalVertices > limits.maxTotalVertices) throw glbError("GLB_COMPLEXITY_LIMIT");
        primitives.push(decoded);
      }
    }

    meshes.push({ primitives });
  }

  return { meshes, totalVertices, skippedUnsupportedPrimitiveCount };
}

function decodePrimitive(doc: GLTFDocument, primitive: GLTFPrimitive, bin: Uint8Array | null, limits: GLBLimits): DecodedPrimitive | null {
  if (primitive.attributes.POSITION === undefined) {
    throw glbError("GLB_POSITION_MISSING");
  }

  const positions = readPositionAccessor(doc, primitive.attributes.POSITION, bin, limits);
  const vertexCount = positions.length / 3;

  const indices = primitive.indices !== undefined ? readIndexAccessor(doc, primitive.indices, bin, limits) : null;
  if (indices) {
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= vertexCount) throw glbError("GLB_INDEX_INVALID");
    }
  }
  const elementCount = indices ? indices.length : vertexCount;
  const getIndex = indices ? (i: number): number => indices[i] : (i: number): number => i;

  const triangleIndices = buildTriangleIndices(primitive.mode, elementCount, getIndex, limits);
  if (triangleIndices.length === 0) {
    return null; // an empty (too-short strip/fan, or zero-index-count) primitive contributes nothing — not an error by itself
  }

  const hasTexCoords = Object.keys(primitive.attributes).some((key) => key.startsWith("TEXCOORD"));
  const hasVertexColors = Object.keys(primitive.attributes).some((key) => key.startsWith("COLOR"));

  return {
    positions,
    triangleIndices,
    hasMaterial: primitive.material !== undefined,
    hasTexCoords,
    hasVertexColors,
    hasMorphTargets: (primitive.targets?.length ?? 0) > 0,
  };
}

function buildTriangleIndices(mode: number, elementCount: number, getIndex: (i: number) => number, limits: GLBLimits): Uint32Array {
  const triangles: number[] = [];
  const pushTriangle = (a: number, b: number, c: number): void => {
    if (triangles.length / 3 >= limits.maxTriangles) throw glbError("GLB_COMPLEXITY_LIMIT");
    triangles.push(a, b, c);
  };

  if (mode === MODE_TRIANGLES) {
    if (elementCount % 3 !== 0) throw glbError("GLB_INDEX_INVALID");
    for (let i = 0; i < elementCount; i += 3) {
      pushTriangle(getIndex(i), getIndex(i + 1), getIndex(i + 2));
    }
  } else if (mode === MODE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < elementCount; i++) {
      // Alternate winding every other triangle so every triangle in the
      // strip faces the same direction — see transforms.test.ts-style
      // dedicated strip-winding tests in primitives.test.ts.
      if (i % 2 === 0) pushTriangle(getIndex(i), getIndex(i + 1), getIndex(i + 2));
      else pushTriangle(getIndex(i + 1), getIndex(i), getIndex(i + 2));
    }
  } else if (mode === MODE_TRIANGLE_FAN) {
    if (elementCount > 0) {
      const center = getIndex(0);
      for (let i = 1; i + 1 < elementCount; i++) {
        pushTriangle(center, getIndex(i), getIndex(i + 1));
      }
    }
  }

  return Uint32Array.from(triangles);
}
