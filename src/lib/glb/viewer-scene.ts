/**
 * Viewer scene resolution: walks Scene → node → child node → mesh →
 * primitive exactly like `resolveGLBScene()` (the converter's own
 * pipeline) — same default-scene/scene-zero-fallback selection (reused
 * directly via `selectRootNodeIndices`), same node-local-matrix
 * computation (`localMatrixForNode`), same cycle detection, same depth
 * ceiling, same instance ceiling, same parent-then-local transform
 * composition (`multiplyMat4`), same reflected-transform detection
 * (`determinantSign3x3`) — all imported, none reimplemented. The real
 * differences: source glTF *meter* coordinates are kept as-is (never the
 * converter's ×1000 millimetre scale), one `GLBViewerSegment` is recorded
 * per node/mesh/primitive visit, source/fallback normals are transformed
 * by the correct inverse-transpose normal matrix (handling non-uniform
 * scale and reflection), and points/lines/materials/textures are carried
 * through instead of being skipped or discarded.
 */
import { computeFaceNormal } from "../stl/normals";
import { glbError } from "./errors";
import { checkRequiredExtensions, parseGLB } from "./convert";
import { parseGLBContainer } from "./container";
import { localMatrixForNode, selectRootNodeIndices } from "./resolve-scene";
import { determinantSign3x3, isFiniteMat4, multiplyMat4, transformPoint } from "./transforms";
import { IDENTITY_MAT4 } from "./types";
import type { GLTFDocument, Mat4 } from "./types";
import { decodeViewerPrimitive, type DecodedViewerPrimitive } from "./viewer-primitives";
import { sanitizeViewerText } from "./viewer-formatting";
import { parseGLTFViewerResources, type GLTFViewerResources } from "./viewer-resources";
import { extractViewerImages, type ExtractedImages } from "./viewer-images";
import {
  DEFAULT_GLB_VIEWER_LIMITS,
  type GLBViewerLimits,
  type GLBViewerResult,
  type GLBViewerSegment,
  type GLBViewerWarning,
  type GLBViewerWarningCode,
} from "./viewer-types";

const WARNING_MESSAGES: Record<GLBViewerWarningCode, string> = {
  "textures-not-rendered": "This file includes metallic-roughness, normal or occlusion textures. This viewer renders base-color textures only — affected surfaces use their material factors instead.",
  "texture-transform-not-applied": "Some textures use a UV transform (KHR_texture_transform) this viewer doesn't apply — those surfaces show material factors instead of the texture.",
  "unsupported-texcoord-set": "Some materials reference a second UV set (TEXCOORD_1 or beyond) this viewer doesn't use — those surfaces show material factors instead of the texture.",
  "unsupported-image-mime": "Some embedded images use a format other than PNG or JPEG, which this viewer doesn't decode.",
  "animations-not-applied": "This file includes animations, which aren't played — only the static base pose is shown.",
  "skins-not-applied": "This file includes a skin (rig), which isn't applied — only the undeformed base mesh is shown.",
  "morph-targets-not-applied": "This file includes morph targets, which aren't applied — only the base shape is shown.",
  "degenerate-triangles-skipped": "Some triangles in this file had no measurable area after transformation and were skipped.",
  "material-reference-invalid": "Some primitives reference a material that doesn't exist — a neutral material was used instead.",
  "texture-reference-invalid": "Some materials reference a texture that doesn't exist — a neutral material was used instead.",
};

interface MutableBounds {
  min: [number, number, number];
  max: [number, number, number];
}

function freshBounds(): MutableBounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function extendBounds(bounds: MutableBounds, x: number, y: number, z: number): void {
  if (x < bounds.min[0]) bounds.min[0] = x;
  if (y < bounds.min[1]) bounds.min[1] = y;
  if (z < bounds.min[2]) bounds.min[2] = z;
  if (x > bounds.max[0]) bounds.max[0] = x;
  if (y > bounds.max[1]) bounds.max[1] = y;
  if (z > bounds.max[2]) bounds.max[2] = z;
}

/** Unions every rendered geometry category's own extent — triangles, lines and points alike — never just whichever one happens to be non-empty first. */
function computeCombinedBounds(triPositions: Float32Array, linePositions: number[], pointPositions: number[]) {
  const bounds = freshBounds();
  const extendFromFlat = (flat: Float32Array | number[]): void => {
    for (let i = 0; i < flat.length; i += 3) extendBounds(bounds, flat[i], flat[i + 1], flat[i + 2]);
  };
  extendFromFlat(triPositions);
  extendFromFlat(linePositions);
  extendFromFlat(pointPositions);
  return finalizeBounds(bounds);
}

function finalizeBounds(bounds: MutableBounds) {
  if (!Number.isFinite(bounds.min[0])) {
    return { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
  }
  return {
    min: bounds.min,
    max: bounds.max,
    size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as [number, number, number],
    center: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2] as [number, number, number],
  };
}

/** Inverse-transpose of the world matrix's upper-left 3x3 (linear) part — the mathematically correct transform for a normal vector, handling non-uniform scale and reflection alike. `null` for a singular (non-invertible) linear part. */
function computeNormalMatrix(m: Mat4): readonly [number, number, number, number, number, number, number, number, number] | null {
  const a = m[0];
  const b = m[4];
  const c = m[8];
  const d = m[1];
  const e = m[5];
  const f = m[9];
  const g = m[2];
  const h = m[6];
  const i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    (e * i - f * h) * invDet, (f * g - d * i) * invDet, (d * h - e * g) * invDet,
    (c * h - b * i) * invDet, (a * i - c * g) * invDet, (b * g - a * h) * invDet,
    (b * f - c * e) * invDet, (c * d - a * f) * invDet, (a * e - b * d) * invDet,
  ];
}

function applyNormalMatrix(nm: readonly number[], nx: number, ny: number, nz: number): [number, number, number] {
  const x = nm[0] * nx + nm[1] * ny + nm[2] * nz;
  const y = nm[3] * nx + nm[4] * ny + nm[5] * nz;
  const z = nm[6] * nx + nm[7] * ny + nm[8] * nz;
  const lengthSq = x * x + y * y + z * z;
  if (!Number.isFinite(lengthSq) || lengthSq < 1e-12) return [nx, ny, nz];
  const inv = 1 / Math.sqrt(lengthSq);
  return [x * inv, y * inv, z * inv];
}

export function resolveGLBViewerScene(
  doc: GLTFDocument,
  bin: Uint8Array | null,
  resources: GLTFViewerResources,
  extractedImages: ExtractedImages,
  limits: GLBViewerLimits = DEFAULT_GLB_VIEWER_LIMITS,
): GLBViewerResult {
  checkRequiredExtensions(doc);

  // Decode every mesh's primitives exactly once, regardless of how many nodes instance it — mirrors primitives.ts's own decode-once contract.
  const decodedMeshes: DecodedViewerPrimitive[][] = doc.meshes.map((mesh) =>
    mesh.primitives
      .map((primitive) => decodeViewerPrimitive(doc, primitive, bin, limits, resources.accessorNormalized))
      .filter((p): p is DecodedViewerPrimitive => p !== null),
  );

  const { rootNodes, sceneName } = selectRootNodeIndices(doc);
  const sceneIndex = doc.scene ?? 0;

  const positions: number[] = [];
  const normals: number[] = [];
  const texcoords: number[] = [];
  const colors0: number[] = [];
  const indices: number[] = [];
  const lineGeometry: number[] = [];
  const lineColors: number[] = [];
  const pointGeometry: number[] = [];
  const pointColors: number[] = [];
  const segments: GLBViewerSegment[] = [];

  let triVertexCount = 0;
  let triIndexCount = 0;
  let renderedTriangleCount = 0;
  let renderedLineCount = 0;
  let renderedPointCount = 0;
  let skippedDegenerateTriangles = 0;
  let nodeInstanceCount = 0;
  let hasAnyTexCoords = false;
  let hasAnyVertexColors = false;
  let hasAnySourceNormals = false;
  let hasInvalidMaterialReference = false;
  const visitedMeshIndices = new Set<number>();

  function pushSegmentBounds(segment: Omit<GLBViewerSegment, "bounds">, bounds: MutableBounds): void {
    if (segments.length >= limits.maxSegments) throw glbError("GLB_VIEWER_SEGMENT_LIMIT");
    segments.push({ ...segment, bounds: finalizeBounds(bounds) });
  }

  function emitTrianglePrimitive(
    decoded: DecodedViewerPrimitive,
    worldMatrix: Mat4,
    normalMatrix: readonly number[] | null,
    reflected: boolean,
    context: { sceneIndex: number; nodeIndex: number; nodePath: number[]; meshIndex: number; primitiveIndex: number; displayName: string | null },
  ): void {
    const localVertexCount = decoded.positions.length / 3;
    const vertexBase = triVertexCount;
    const bounds = freshBounds();

    for (let v = 0; v < localVertexCount; v++) {
      const [x, y, z] = transformPoint(worldMatrix, [decoded.positions[v * 3], decoded.positions[v * 3 + 1], decoded.positions[v * 3 + 2]]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw glbError("GLB_TRANSFORM_INVALID");
      positions.push(x, y, z);
      extendBounds(bounds, x, y, z);

      const nx = decoded.normals[v * 3];
      const ny = decoded.normals[v * 3 + 1];
      const nz = decoded.normals[v * 3 + 2];
      const [tnx, tny, tnz] = normalMatrix ? applyNormalMatrix(normalMatrix, nx, ny, nz) : [nx, ny, nz];
      normals.push(tnx, tny, tnz);

      if (decoded.texcoords) {
        texcoords.push(decoded.texcoords[v * 2], decoded.texcoords[v * 2 + 1]);
      } else {
        texcoords.push(0, 0);
      }
      if (decoded.colors) {
        colors0.push(decoded.colors[v * 4], decoded.colors[v * 4 + 1], decoded.colors[v * 4 + 2], decoded.colors[v * 4 + 3]);
      } else {
        colors0.push(1, 1, 1, 1);
      }
      triVertexCount++;
    }

    const indexStart = triIndexCount;
    const triCount = decoded.triangleIndices.length / 3;
    for (let t = 0; t < triCount; t++) {
      if (renderedTriangleCount >= limits.maxTriangles) throw glbError("GLB_COMPLEXITY_LIMIT");
      let i0 = decoded.triangleIndices[t * 3];
      let i1 = decoded.triangleIndices[t * 3 + 1];
      let i2 = decoded.triangleIndices[t * 3 + 2];
      if (reflected) {
        const swap = i1;
        i1 = i2;
        i2 = swap;
      }
      const g0 = vertexBase + i0;
      const g1 = vertexBase + i1;
      const g2 = vertexBase + i2;

      const normal = computeFaceNormal(
        positions[g0 * 3], positions[g0 * 3 + 1], positions[g0 * 3 + 2],
        positions[g1 * 3], positions[g1 * 3 + 1], positions[g1 * 3 + 2],
        positions[g2 * 3], positions[g2 * 3 + 1], positions[g2 * 3 + 2],
      );
      if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
        // Zero-area after transformation — same documented policy resolveGLBScene() uses: skip, count, warn.
        skippedDegenerateTriangles++;
        continue;
      }

      indices.push(g0, g1, g2);
      triIndexCount += 3;
      renderedTriangleCount++;
    }

    const materialIndex = resolveMaterialIndex(decoded.materialIndex, resources.materials.length, () => {
      hasInvalidMaterialReference = true;
    });

    pushSegmentBounds(
      { ...context, mode: 4, renderCategory: "triangles", materialIndex, indexStart, indexCount: triIndexCount - indexStart },
      bounds,
    );
  }

  function emitLinePrimitive(
    decoded: DecodedViewerPrimitive,
    worldMatrix: Mat4,
    context: { sceneIndex: number; nodeIndex: number; nodePath: number[]; meshIndex: number; primitiveIndex: number; displayName: string | null },
  ): void {
    const bounds = freshBounds();
    const indexStart = renderedLineCount;
    const segmentCount = decoded.lineIndices.length / 2;
    if (renderedLineCount + segmentCount > limits.maxLineSegments) throw glbError("GLB_VIEWER_SEGMENT_LIMIT");

    for (let s = 0; s < segmentCount; s++) {
      for (const localIdx of [decoded.lineIndices[s * 2], decoded.lineIndices[s * 2 + 1]]) {
        const [x, y, z] = transformPoint(worldMatrix, [
          decoded.positions[localIdx * 3],
          decoded.positions[localIdx * 3 + 1],
          decoded.positions[localIdx * 3 + 2],
        ]);
        lineGeometry.push(x, y, z);
        extendBounds(bounds, x, y, z);
        if (decoded.colors) {
          lineColors.push(decoded.colors[localIdx * 4], decoded.colors[localIdx * 4 + 1], decoded.colors[localIdx * 4 + 2]);
        } else {
          lineColors.push(1, 1, 1);
        }
      }
    }
    renderedLineCount += segmentCount;

    pushSegmentBounds(
      { ...context, mode: 1, renderCategory: "lines", materialIndex: null, indexStart, indexCount: segmentCount },
      bounds,
    );
  }

  function emitPointPrimitive(
    decoded: DecodedViewerPrimitive,
    worldMatrix: Mat4,
    context: { sceneIndex: number; nodeIndex: number; nodePath: number[]; meshIndex: number; primitiveIndex: number; displayName: string | null },
  ): void {
    const bounds = freshBounds();
    const indexStart = renderedPointCount;
    const count = decoded.pointIndices.length;
    if (renderedPointCount + count > limits.maxPoints) throw glbError("GLB_VIEWER_SEGMENT_LIMIT");

    for (let p = 0; p < count; p++) {
      const localIdx = decoded.pointIndices[p];
      const [x, y, z] = transformPoint(worldMatrix, [decoded.positions[localIdx * 3], decoded.positions[localIdx * 3 + 1], decoded.positions[localIdx * 3 + 2]]);
      pointGeometry.push(x, y, z);
      extendBounds(bounds, x, y, z);
      if (decoded.colors) {
        pointColors.push(decoded.colors[localIdx * 4], decoded.colors[localIdx * 4 + 1], decoded.colors[localIdx * 4 + 2]);
      } else {
        pointColors.push(1, 1, 1);
      }
    }
    renderedPointCount += count;

    pushSegmentBounds(
      { ...context, mode: 0, renderCategory: "points", materialIndex: null, indexStart, indexCount: count },
      bounds,
    );
  }

  function visitNode(nodeIndex: number, parentWorld: Mat4, depth: number, ancestry: ReadonlySet<number>, nodePath: number[]): void {
    if (depth > limits.maxSceneDepth) throw glbError("GLB_NODE_DEPTH_EXCEEDED");
    if (ancestry.has(nodeIndex)) throw glbError("GLB_NODE_CYCLE");

    const node = doc.nodes[nodeIndex];
    if (!node) throw glbError("GLB_NODE_INVALID");

    const worldMatrix = multiplyMat4(parentWorld, localMatrixForNode(node));
    if (!isFiniteMat4(worldMatrix)) throw glbError("GLB_TRANSFORM_INVALID");

    if (node.mesh !== undefined) {
      const primitives = decodedMeshes[node.mesh];
      if (!primitives) throw glbError("GLB_NODE_INVALID");

      nodeInstanceCount++;
      if (nodeInstanceCount > limits.maxSceneInstances) throw glbError("GLB_COMPLEXITY_LIMIT");
      if (primitives.length > 0) visitedMeshIndices.add(node.mesh);

      const reflected = determinantSign3x3(worldMatrix) < 0;
      const normalMatrix = computeNormalMatrix(worldMatrix);
      const displayName = node.name ? sanitizeViewerText(node.name, limits.maxNameLength) : null;

      primitives.forEach((decoded, primitiveIndex) => {
        hasAnyTexCoords = hasAnyTexCoords || decoded.texcoords !== null;
        hasAnyVertexColors = hasAnyVertexColors || decoded.colors !== null;
        hasAnySourceNormals = hasAnySourceNormals || decoded.hasSourceNormals;

        const context = { sceneIndex, nodeIndex, nodePath: nodePath.slice(), meshIndex: node.mesh!, primitiveIndex, displayName };
        if (decoded.renderCategory === "triangles") {
          emitTrianglePrimitive(decoded, worldMatrix, normalMatrix, reflected, context);
        } else if (decoded.renderCategory === "lines") {
          emitLinePrimitive(decoded, worldMatrix, context);
        } else {
          emitPointPrimitive(decoded, worldMatrix, context);
        }
      });
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeIndex);
    const nextPath = [...nodePath, nodeIndex];
    for (const childIndex of node.children) {
      visitNode(childIndex, worldMatrix, depth + 1, nextAncestry, nextPath);
    }
  }

  for (const rootIndex of rootNodes) {
    visitNode(rootIndex, IDENTITY_MAT4, 0, new Set(), []);
  }

  if (positions.length === 0 && lineGeometry.length === 0 && pointGeometry.length === 0) {
    throw glbError("GLB_VIEWER_NO_RENDERABLE_GEOMETRY");
  }

  const positionArray = Float32Array.from(positions);
  let primitiveCount = 0;
  let sourceVertexCount = 0;
  for (const meshIndex of visitedMeshIndices) {
    primitiveCount += decodedMeshes[meshIndex].length;
    for (const p of decodedMeshes[meshIndex]) sourceVertexCount += p.positions.length / 3;
  }

  let hasTangents = false;
  let tangentCount = 0;
  let additionalTexCoordSetCount = 0;
  let morphTargetCount = 0;
  for (const primitives of decodedMeshes) {
    for (const p of primitives) {
      if (p.hasTangent) {
        hasTangents = true;
        tangentCount += p.tangentCount;
      }
      morphTargetCount += p.morphTargetCount;
    }
  }
  for (const mesh of doc.meshes) {
    for (const primitive of mesh.primitives) {
      const extraSets = Object.keys(primitive.attributes).filter((k) => k.startsWith("TEXCOORD_") && k !== "TEXCOORD_0");
      additionalTexCoordSetCount += extraSets.length;
    }
  }

  const hasUnsupportedTextureMap = resources.materials.some((m) => m.hasUnsupportedTextureMap);
  const hasDisabledBaseColorTexture = resources.materials.some((m) => m.baseColorTextureDisabled);

  const warnings: GLBViewerWarning[] = [];
  const addWarning = (code: GLBViewerWarningCode): void => {
    if (!warnings.some((w) => w.code === code)) warnings.push({ code, message: WARNING_MESSAGES[code] });
  };
  if (hasUnsupportedTextureMap) addWarning("textures-not-rendered");
  if (hasDisabledBaseColorTexture) addWarning("texture-transform-not-applied");
  if (additionalTexCoordSetCount > 0) addWarning("unsupported-texcoord-set");
  if (doc.animationCount > 0) addWarning("animations-not-applied");
  if (doc.skinCount > 0) addWarning("skins-not-applied");
  if (morphTargetCount > 0) addWarning("morph-targets-not-applied");
  if (skippedDegenerateTriangles > 0) addWarning("degenerate-triangles-skipped");
  if (hasInvalidMaterialReference || resources.hasInvalidTextureReference) addWarning("material-reference-invalid");
  if (extractedImages.hasUnsupportedMime) addWarning("unsupported-image-mime");

  return {
    sourceUnit: "meter",
    positions: positionArray,
    normals: Float32Array.from(normals),
    texcoords0: hasAnyTexCoords ? Float32Array.from(texcoords) : undefined,
    colors0: hasAnyVertexColors ? Float32Array.from(colors0) : undefined,
    indices: Uint32Array.from(indices),
    lineGeometry: lineGeometry.length > 0 ? Float32Array.from(lineGeometry) : undefined,
    lineColors: lineGeometry.length > 0 ? Float32Array.from(lineColors) : undefined,
    pointGeometry: pointGeometry.length > 0 ? Float32Array.from(pointGeometry) : undefined,
    pointColors: pointGeometry.length > 0 ? Float32Array.from(pointColors) : undefined,
    segments,
    materials: resources.materials,
    textures: resources.textures,
    images: extractedImages.images,
    boundsMeters: computeCombinedBounds(positionArray, lineGeometry, pointGeometry),
    gltfVersion: doc.asset.version,
    sceneCount: doc.scenes.length,
    nodeCount: doc.nodes.length,
    selectedSceneName: sceneName,
    meshCount: visitedMeshIndices.size,
    primitiveCount,
    nodeInstanceCount,
    sourceVertexCount,
    renderedTriangleCount,
    renderedLineCount,
    renderedPointCount,
    skippedDegenerateTriangles,
    hasSourceNormals: hasAnySourceNormals,
    hasTangents,
    tangentCount,
    hasVertexColors: hasAnyVertexColors,
    hasTexCoords: hasAnyTexCoords,
    additionalTexCoordSetCount,
    animationCount: doc.animationCount,
    skinCount: doc.skinCount,
    morphTargetCount,
    extensionsUsed: doc.extensionsUsed,
    extensionsRequired: doc.extensionsRequired,
    warnings,
  };
}

/** Convenience wrapper for callers that don't need the parse/resolve stages split (tests, and anywhere outside the worker's staged pipeline). */
export function resolveGLBViewerPackage(buffer: ArrayBuffer, limits: GLBViewerLimits = DEFAULT_GLB_VIEWER_LIMITS): GLBViewerResult {
  const { json, bin } = parseGLBContainer(buffer, limits);
  const { doc } = parseGLB(buffer, limits);
  const resources = parseGLTFViewerResources(json, limits);
  const extractedImages = extractViewerImages(doc, bin, resources.images, limits);
  return resolveGLBViewerScene(doc, bin, resources, extractedImages, limits);
}

function resolveMaterialIndex(raw: number | null, materialCount: number, markInvalid: () => void): number | null {
  if (raw === null) return null;
  if (raw < 0 || raw >= materialCount) {
    markInvalid();
    return null;
  }
  return raw;
}
