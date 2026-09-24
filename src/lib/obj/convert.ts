import { objError } from "./errors";
import { parseOBJDocument, type ParsedOBJDocument } from "./parser";
import { computeBounds } from "../stl/bounds";
import { resolveNormals } from "../stl/normals";
import { describeCount } from "./formatting";
import { DEFAULT_OBJ_LIMITS, type ConversionWarning, type OBJLimits, type OBJParseResult } from "./types";

/**
 * Flattens a parsed OBJ document into STL-ready geometry: expands the
 * (deduplicated) vertex/triangle graph into a flat, non-indexed position
 * buffer (matching the layout `serializeBinarySTL` and the 3MF converter
 * both use), recalculates face normals from the final triangle positions
 * (never trusting OBJ's own `vn` values — see module docs below), computes
 * bounds, and assembles the warning list.
 *
 * Split from `parseOBJDocument` so the worker can report a distinct
 * "building-geometry" progress stage after the (usually much slower)
 * "parsing" stage completes.
 */
export function buildOBJGeometry(doc: ParsedOBJDocument, limits: OBJLimits = DEFAULT_OBJ_LIMITS): OBJParseResult {
  if (doc.triangles.length === 0) {
    if (doc.sourceFaceCount === 0 && (doc.ignoredLineCount > 0 || doc.ignoredPointCount > 0)) {
      throw objError("OBJ_UNSUPPORTED_GEOMETRY");
    }
    if (doc.sourceVertexCount === 0 && doc.sourceFaceCount === 0) {
      throw objError("OBJ_EMPTY_GEOMETRY");
    }
    throw objError("OBJ_NO_FACE_GEOMETRY");
  }

  const triangleCount = doc.triangles.length;
  if (triangleCount > limits.maxTriangles) throw objError("OBJ_TRIANGLE_LIMIT_EXCEEDED");

  const positions = new Float32Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    const tri = doc.triangles[t];
    const base = t * 9;
    writeVertex(positions, base, doc.positions, tri.a);
    writeVertex(positions, base + 3, doc.positions, tri.b);
    writeVertex(positions, base + 6, doc.positions, tri.c);
  }

  // STL stores exactly one geometric normal per triangle and can't express
  // OBJ's per-vertex smooth-shading interpolation — so `vn` values (already
  // validated for syntax during parsing) are never read here. Every normal
  // is recomputed from the final triangle's own vertex positions.
  const normals = resolveNormals(positions, new Float32Array(positions.length));
  const bounds = computeBounds(positions);

  return {
    positions,
    normals,
    triangleCount,
    sourceVertexCount: doc.sourceVertexCount,
    sourceFaceCount: doc.sourceFaceCount,
    objectCount: doc.objectCount,
    groupCount: doc.groupCount,
    materialLibraryCount: doc.materialLibraryCount,
    usedMaterialCount: doc.usedMaterialCount,
    ignoredLineCount: doc.ignoredLineCount,
    ignoredPointCount: doc.ignoredPointCount,
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

function buildWarnings(doc: ParsedOBJDocument): ConversionWarning[] {
  const warnings: ConversionWarning[] = [];

  if (doc.materialLibraryCount > 0 || doc.usedMaterialCount > 0) {
    warnings.push({
      code: "materials-not-preserved",
      message: "This file references materials, but STL has no field for them — surface geometry only is exported.",
    });
  }
  if (doc.hasTextureCoordinates) {
    warnings.push({
      code: "textures-not-preserved",
      message: "Texture coordinates in this file aren't included in the STL output.",
    });
  }
  if (doc.usesSmoothShading || doc.hasVertexNormals) {
    warnings.push({
      code: "smooth-shading-converted",
      message: "Smooth shading is converted to flat geometric face normals — STL can't store smoothing groups.",
    });
  }
  if (doc.objectCount > 1 || doc.groupCount > 1) {
    warnings.push({
      code: "groups-merged",
      message: "Multiple objects and groups in this file are merged into a single STL mesh.",
    });
  }
  if (doc.hasVertexColorData) {
    warnings.push({
      code: "vertex-colors-not-preserved",
      message: "Vertex colors in this file aren't included in the STL output.",
    });
  }
  if (doc.ignoredLineCount > 0) {
    const verb = doc.ignoredLineCount === 1 ? "was" : "were";
    warnings.push({
      code: "lines-ignored",
      message: `${describeCount(doc.ignoredLineCount, "line primitive")} in this file can't be represented in STL and ${verb} ignored.`,
    });
  }
  if (doc.ignoredPointCount > 0) {
    const verb = doc.ignoredPointCount === 1 ? "was" : "were";
    warnings.push({
      code: "points-ignored",
      message: `${describeCount(doc.ignoredPointCount, "point primitive")} in this file can't be represented in STL and ${verb} ignored.`,
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
export function convertOBJText(text: string, limits: OBJLimits = DEFAULT_OBJ_LIMITS): OBJParseResult {
  const doc = parseOBJDocument(text, limits);
  return buildOBJGeometry(doc, limits);
}
