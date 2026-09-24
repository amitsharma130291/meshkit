import { plyError } from "./errors";
import { parsePLYDocument, type ParsedPLYDocument } from "./parser";
import { computeBounds } from "../stl/bounds";
import { resolveNormals } from "../stl/normals";
import { describeCount } from "./formatting";
import { DEFAULT_PLY_LIMITS, type ConversionWarning, type PLYLimits, type PLYParseResult } from "./types";

/**
 * Flattens a parsed PLY document into STL-ready geometry: expands the
 * (deduplicated) vertex/triangle graph into a flat, non-indexed position
 * buffer (matching the layout `serializeBinarySTL` and every other
 * converter in this app use), computes face normals from the final
 * triangle positions (PLY vertex normals, if present, describe smooth
 * shading STL can't represent — never trusted here, same policy as the
 * OBJ converter), computes bounds, and assembles the warning list.
 *
 * Split from `parsePLYDocument` so the worker can report a distinct
 * "building-geometry" progress stage after the (usually much slower)
 * "reading" stages complete.
 */
export function buildPLYGeometry(doc: ParsedPLYDocument, limits: PLYLimits = DEFAULT_PLY_LIMITS): PLYParseResult {
  if (doc.triangles.length === 0) {
    if (doc.sourceVertexCount === 0 && doc.sourceFaceCount === 0) {
      throw plyError("PLY_EMPTY_GEOMETRY");
    }
    throw plyError("PLY_NO_FACE_GEOMETRY");
  }

  const triangleCount = doc.triangles.length;
  if (triangleCount > limits.maxTriangles) throw plyError("PLY_TRIANGLE_LIMIT_EXCEEDED");

  const positions = new Float32Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    const tri = doc.triangles[t];
    const base = t * 9;
    writeVertex(positions, base, doc.positions, tri.a);
    writeVertex(positions, base + 3, doc.positions, tri.b);
    writeVertex(positions, base + 6, doc.positions, tri.c);
  }

  const normals = resolveNormals(positions, new Float32Array(positions.length));
  const bounds = computeBounds(positions);

  return {
    positions,
    normals,
    triangleCount,
    sourceVertexCount: doc.sourceVertexCount,
    sourceFaceCount: doc.sourceFaceCount,
    vertexPropertyCount: doc.vertexPropertyCount,
    facePropertyCount: doc.facePropertyCount,
    unknownElementCount: doc.unknownElementCount,
    unknownPropertyCount: doc.unknownPropertyCount,
    format: doc.format,
    bounds,
    warnings: buildWarnings(doc),
  };
}

function writeVertex(target: Float32Array, offset: number, source: number[], vertexIndex: number): void {
  const base = vertexIndex * 3;
  target[offset] = source[base];
  target[offset + 1] = source[base + 1];
  target[offset + 2] = source[base + 2];
}

function buildWarnings(doc: ParsedPLYDocument): ConversionWarning[] {
  const warnings: ConversionWarning[] = [];

  if (doc.hasVertexColors) {
    warnings.push({
      code: "vertex-colors-not-preserved",
      message: "Vertex colors in this file aren't included in the STL output.",
    });
  }
  if (doc.hasVertexNormals) {
    warnings.push({
      code: "vertex-normals-not-preserved",
      message: "Vertex normals in this file are replaced with flat geometric face normals — STL can't store smoothing data.",
    });
  }
  if (doc.hasTextureCoordinates) {
    warnings.push({
      code: "texture-coordinates-not-preserved",
      message: "Texture coordinates in this file aren't included in the STL output.",
    });
  }
  if (doc.unknownElementCount > 0) {
    const verb = doc.unknownElementCount === 1 ? "isn't" : "aren't";
    warnings.push({
      code: "unknown-elements-skipped",
      message: `${describeCount(doc.unknownElementCount, "element")} in this file (other than vertex and face) ${verb} recognized and ${doc.unknownElementCount === 1 ? "was" : "were"} skipped.`,
    });
  }
  if (doc.unknownPropertyCount > 0) {
    const verb = doc.unknownPropertyCount === 1 ? "isn't" : "aren't";
    warnings.push({
      code: "unknown-properties-skipped",
      message: `${describeCount(doc.unknownPropertyCount, "property")} in this file ${verb} recognized and ${doc.unknownPropertyCount === 1 ? "was" : "were"} skipped.`,
    });
  }
  if (doc.hasDoublePrecisionSource) {
    warnings.push({
      code: "double-precision-narrowed",
      message: "This file's coordinates are double-precision and were narrowed to single-precision (float32) for the STL output.",
    });
  }
  if (doc.hasNonPlanarFaces) {
    warnings.push({
      code: "non-planar-faces",
      message: "Some faces in this file aren't perfectly flat — MeshWrench triangulated them with a small tolerance.",
    });
  }

  return warnings;
}

/** Convenience wrapper for callers that don't need the parsing/geometry stages split (tests, and anywhere outside the worker's staged pipeline). */
export function convertPLYBuffer(buffer: ArrayBuffer, limits: PLYLimits = DEFAULT_PLY_LIMITS): PLYParseResult {
  const doc = parsePLYDocument(buffer, limits);
  return buildPLYGeometry(doc, limits);
}
