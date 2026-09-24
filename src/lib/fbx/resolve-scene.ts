/**
 * Orchestrates every other module into the final viewer scene: resolves
 * the Model hierarchy (connections.ts), composes each Model's local +
 * geometric transform (transforms.ts) into a normalized world space
 * (axis system + unit scale, applied exactly once, globally — never
 * per-node), decodes each distinct Geometry exactly once regardless of
 * how many Models reference it, resolves layer elements (normals/UVs/
 * colors/materials) per corner, and extracts embedded textures. Vertex
 * layout is per-corner and non-indexed — closer to OBJ's own convention
 * than GLB's indexed one, since FBX layer elements are themselves
 * fundamentally per-corner/per-polygon data — with a same-order identity
 * `indices` array included purely so `_client.ts` can re-slice it per
 * visible segment without ever duplicating the position/normal/UV/color
 * buffers (the same index-buffer visibility technique the OBJ and GLB
 * viewers already use).
 */
import { computeFaceNormal } from "../stl/normals";
import type { STLBounds } from "../stl/types";
import { buildConnectionGraph, connectedObjectsOfClass, resolveModelHierarchy, type FBXModelTreeNode } from "./connections";
import { findChild, interpretFBXDocument, readProperties70 } from "./document";
import type { FBXObjectId, FBXRawObject } from "./document";
import { fbxError } from "./errors";
import { parseGlobalSettings, type FBXAxisSystem } from "./global-settings";
import { decodeFBXGeometry, type FBXDecodedGeometry } from "./geometry";
import { extractVideoContent } from "./images";
import { readIntegerLayerElement, readLayerElementSource, resolveLayerElementValue, resolveMaterialIndex } from "./layer-elements";
import { decodeFBXMaterial } from "./materials";
import { parseFBXBinary } from "./binary-parser";
import {
  IDENTITY_MAT4,
  composeGeometricMatrix,
  composeLocalMatrix,
  computeNormalMatrix,
  applyNormalMatrix,
  determinantSign3x3,
  multiplyMat4,
  readNodeTransformProperties,
  transformPoint,
  validateFiniteMatrix,
  type Mat4,
} from "./transforms";
import {
  DEFAULT_FBX_VIEWER_LIMITS,
  type FBXUnsupportedFeature,
  type FBXViewerImage,
  type FBXViewerLimits,
  type FBXViewerMaterial,
  type FBXViewerResult,
  type FBXViewerSegment,
  type FBXViewerWarning,
  type FBXViewerWarningCode,
} from "./viewer-types";

const WARNING_MESSAGES: Record<FBXViewerWarningCode, string> = {
  "layer-element-unsupported-mapping": "Some normal, UV, color or material data in this file uses a mapping mode this viewer doesn't recognize — a computed fallback was used where possible.",
  "layer-element-unsupported-reference": "Some normal, UV, color or material data in this file uses a reference mode this viewer doesn't recognize — a computed fallback was used where possible.",
  "layer-element-invalid-index": "Some normal, UV, color or material data in this file references an index that doesn't exist — a computed fallback was used where possible.",
  "geometric-fallback-normals": "Some normals in this file are missing or invalid — a computed geometric normal was used instead.",
  "additional-uv-sets-not-rendered": "This file declares more than one UV set. Only the first is shown.",
  "unsupported-inherit-type": "Some models use a scale-inheritance mode this viewer approximates rather than fully supports.",
  "unsupported-rotation-order": "Some models use a spherical rotation order this viewer doesn't support — a standard XYZ order was used instead.",
  "multiple-structural-parents": "Some models are connected to more than one parent. The first was used.",
  "degenerate-polygons-skipped": "Some polygons in this file had no measurable area, or a shape this viewer couldn't safely triangulate, and were skipped.",
  "unsupported-embedded-image-format": "Some embedded textures use a format other than PNG or JPEG, which this viewer doesn't decode.",
  "external-texture-not-fetched": "Some textures reference an external image file, which MeshWrench never fetches.",
  "unrecognized-object-types": "This file includes object types this viewer doesn't render (see the unsupported-features summary).",
  "material-reference-invalid": "Some models reference a material that doesn't exist — a neutral material was used instead.",
  "axis-system-unknown": "This file doesn't declare a complete, consistent axis system — coordinates are shown unconverted, in model units.",
  "unit-scale-unknown": "This file doesn't declare a usable unit scale — coordinates are shown unconverted, in model units.",
};

interface MutableBounds {
  min: [number, number, number];
  max: [number, number, number];
}

function freshBounds(): MutableBounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function extendBounds(b: MutableBounds, x: number, y: number, z: number): void {
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

function finalizeBounds(b: MutableBounds): STLBounds {
  if (!Number.isFinite(b.min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min: b.min,
    max: b.max,
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
  };
}

/** A signed-permutation matrix mapping FBX's own (X,Y,Z) axes to a right-handed Y-up target basis, per `GlobalSettings`' own axis declarations — built once and applied globally, never per node. */
function buildAxisRemapMat4(axis: FBXAxisSystem): Mat4 {
  const m = new Array(16).fill(0) as number[];
  m[15] = 1;
  m[axis.coordAxis * 4 + 0] = axis.coordSign;
  m[axis.upAxis * 4 + 1] = axis.upSign;
  m[axis.frontAxis * 4 + 2] = axis.frontSign;
  return m as unknown as Mat4;
}

function normalizeVec3(v: readonly number[]): [number, number, number] {
  const [x, y, z] = v;
  const lenSq = x * x + y * y + z * z;
  if (!Number.isFinite(lenSq) || lenSq < 1e-12) return [0, 0, 0];
  const inv = 1 / Math.sqrt(lenSq);
  return [x * inv, y * inv, z * inv];
}

function computeFallbackNormalsPerControlPoint(decoded: FBXDecodedGeometry): Float64Array {
  const accum = new Float64Array(decoded.controlPointCount * 3);
  const cp = decoded.controlPoints;
  for (const tri of decoded.triangles) {
    const [a, b, c] = tri.controlPointIndices;
    const [nx, ny, nz] = computeFaceNormal(cp[a * 3], cp[a * 3 + 1], cp[a * 3 + 2], cp[b * 3], cp[b * 3 + 1], cp[b * 3 + 2], cp[c * 3], cp[c * 3 + 1], cp[c * 3 + 2]);
    for (const idx of [a, b, c]) {
      accum[idx * 3] += nx;
      accum[idx * 3 + 1] += ny;
      accum[idx * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < decoded.controlPointCount; i++) {
    const [nx, ny, nz] = normalizeVec3([accum[i * 3], accum[i * 3 + 1], accum[i * 3 + 2]]);
    accum[i * 3] = nx;
    accum[i * 3 + 1] = ny;
    accum[i * 3 + 2] = nz;
  }
  return accum;
}

const UNSUPPORTED_MODEL_SUBCLASS: Record<string, FBXUnsupportedFeature> = { Camera: "cameras", Light: "lights", LimbNode: "skeleton" };
const UNSUPPORTED_GEOMETRY_SUBCLASS: Record<string, FBXUnsupportedFeature> = {
  Nurbs: "nurbs-or-patch-geometry",
  NurbsSurface: "nurbs-or-patch-geometry",
  NurbsCurve: "nurbs-or-patch-geometry",
  Patch: "nurbs-or-patch-geometry",
  Subdiv: "subdivision-surfaces",
};

function classifyUnsupportedFeature(obj: FBXRawObject): FBXUnsupportedFeature | null {
  if (obj.fbxClass === "AnimationStack" || obj.fbxClass === "AnimationLayer" || obj.fbxClass === "AnimCurveNode" || obj.fbxClass === "AnimCurve") return "animation";
  if (obj.fbxClass === "Deformer") return obj.subclass === "BlendShape" || obj.subclass === "BlendShapeChannel" ? "blend-shapes" : "skinning";
  if (obj.fbxClass === "Constraint") return "constraints";
  if (obj.fbxClass === "NodeAttribute") {
    if (obj.subclass === "Skeleton") return "skeleton";
    if (obj.subclass === "Camera") return "cameras";
    if (obj.subclass === "Light") return "lights";
    return null;
  }
  if (obj.fbxClass === "Model" && UNSUPPORTED_MODEL_SUBCLASS[obj.subclass]) return UNSUPPORTED_MODEL_SUBCLASS[obj.subclass];
  if (obj.fbxClass === "Geometry" && UNSUPPORTED_GEOMETRY_SUBCLASS[obj.subclass]) return UNSUPPORTED_GEOMETRY_SUBCLASS[obj.subclass];
  return null;
}

/**
 * The "back half" of scene resolution — everything after the node tree
 * has been parsed and interpreted into objects/connections. Split out
 * from `resolveFBXViewerScene()` purely so `fbx-viewer.worker.ts` can
 * report progress at real stage boundaries (parse → interpret/connect →
 * build) instead of one opaque call; nothing here re-parses anything the
 * earlier stages already did.
 */
export function resolveFBXViewerSceneFromDocument(
  parsedVersion: number,
  uses64BitRecords: boolean,
  doc: ReturnType<typeof interpretFBXDocument>,
  graph: ReturnType<typeof buildConnectionGraph>,
  limits: FBXViewerLimits = DEFAULT_FBX_VIEWER_LIMITS,
): FBXViewerResult {
  const globalSettings = parseGlobalSettings(doc.globalSettingsNode);

  const warnings: FBXViewerWarning[] = [];
  const seenWarnings = new Set<FBXViewerWarningCode>();
  const addWarning = (code: FBXViewerWarningCode): void => {
    if (seenWarnings.has(code)) return;
    seenWarnings.add(code);
    warnings.push({ code, message: WARNING_MESSAGES[code] });
  };

  const axisSystemKnown = globalSettings.axisSystem !== null;
  if (!axisSystemKnown) addWarning("axis-system-unknown");
  const normalizedToMeters = globalSettings.unitScaleFactor !== null;
  if (!normalizedToMeters) addWarning("unit-scale-unknown");

  const axisMat = axisSystemKnown ? buildAxisRemapMat4(globalSettings.axisSystem!) : IDENTITY_MAT4;
  const scaleFactor = normalizedToMeters ? globalSettings.unitScaleFactor! / 100 : 1;
  // axisMat is a pure linear (no-translation) matrix, so uniformly scaling every entry (including the always-zero translation column) is equivalent to composing scaleMat4(scaleFactor) · axisMat, and cheaper.
  const scaledAxisMat: Mat4 = axisMat.map((v) => v * scaleFactor) as unknown as Mat4;
  const normalMatrixForNormalization = computeNormalMatrix(scaledAxisMat);

  if (graph.multiParentObjectIds.size > 0) addWarning("multiple-structural-parents");

  const unsupportedFeatures = new Set<FBXUnsupportedFeature>();
  let unrecognizedObjectClassCount = 0;
  const RECOGNIZED_CLASSES = new Set(["Model", "Geometry", "Material", "Texture", "Video"]);
  for (const obj of doc.objects) {
    if (!RECOGNIZED_CLASSES.has(obj.fbxClass)) unrecognizedObjectClassCount++;
    const feature = classifyUnsupportedFeature(obj);
    if (feature) unsupportedFeatures.add(feature);
  }
  if (unrecognizedObjectClassCount > 0) addWarning("unrecognized-object-types");

  const modelRoots = resolveModelHierarchy(graph, limits);

  // --- Materials & textures (decoded once per referenced object, regardless of how many Models use them) ---

  const images: (FBXViewerImage | null)[] = [];
  const imageIndexByVideoId = new Map<FBXObjectId, number | null>();
  function resolveVideoImage(videoId: FBXObjectId): number | null {
    if (imageIndexByVideoId.has(videoId)) return imageIndexByVideoId.get(videoId)!;
    const videoObj = graph.objectById.get(videoId);
    if (!videoObj || videoObj.fbxClass !== "Video") {
      imageIndexByVideoId.set(videoId, null);
      return null;
    }
    const result = extractVideoContent(videoObj.node, limits);
    if (result.isUnsupportedFormat) addWarning("unsupported-embedded-image-format");
    if (result.isExternalOnly) addWarning("external-texture-not-fetched");
    if (!result.image) {
      imageIndexByVideoId.set(videoId, null);
      return null;
    }
    if (images.length >= limits.maxImageCount) throw fbxError("FBX_IMAGE_COUNT_EXCEEDED");
    const index = images.length;
    images.push(result.image);
    imageIndexByVideoId.set(videoId, index);
    return index;
  }

  const materials: FBXViewerMaterial[] = [];
  const materialIndexById = new Map<FBXObjectId, number>();
  let embeddedTextureCount = 0;
  let externalTextureReferenceCount = 0;

  function resolveMaterialObjectIndex(materialObj: FBXRawObject): number {
    const existing = materialIndexById.get(materialObj.id);
    if (existing !== undefined) return existing;
    if (materials.length >= limits.maxMaterialCount) throw fbxError("FBX_MATERIAL_COUNT_EXCEEDED");

    const decoded = decodeFBXMaterial(materialObj.name, materialObj.node);
    const textureObjs = connectedObjectsOfClass(graph, materialObj.id, "Texture");
    if (textureObjs.length > limits.maxTextureCount) throw fbxError("FBX_TEXTURE_COUNT_EXCEEDED");
    let embeddedImageIndex: number | null = null;
    let hasExternalOrUnsupported = false;
    for (const texObj of textureObjs) {
      const videoObjs = connectedObjectsOfClass(graph, texObj.id, "Video");
      if (videoObjs.length === 0) {
        hasExternalOrUnsupported = true;
        externalTextureReferenceCount++;
        addWarning("external-texture-not-fetched");
        continue;
      }
      const imgIndex = resolveVideoImage(videoObjs[0].id);
      if (imgIndex !== null && embeddedImageIndex === null) {
        embeddedImageIndex = imgIndex;
        embeddedTextureCount++;
      } else if (imgIndex === null) {
        hasExternalOrUnsupported = true;
      }
    }
    if (textureObjs.length > 1) unsupportedFeatures.add("layered-textures");

    const material: FBXViewerMaterial = {
      name: decoded.name,
      shadingModel: decoded.shadingModel,
      diffuseColor: decoded.diffuseColor,
      diffuseFactor: decoded.diffuseFactor,
      opacity: decoded.opacity,
      embeddedImageIndex,
      hasExternalOrUnsupportedTexture: hasExternalOrUnsupported,
    };
    const index = materials.length;
    materials.push(material);
    materialIndexById.set(materialObj.id, index);
    return index;
  }

  // --- Geometry decode cache ---

  const geometryCache = new Map<FBXObjectId, FBXDecodedGeometry | null>();
  let visitedGeometryCount = 0;
  function getDecodedGeometry(geomObj: FBXRawObject): FBXDecodedGeometry | null {
    const cached = geometryCache.get(geomObj.id);
    if (cached !== undefined) return cached;
    if (geomObj.subclass !== "Mesh") {
      geometryCache.set(geomObj.id, null);
      return null; // NURBS/Patch/Subdiv — already counted as an unsupported feature above
    }
    visitedGeometryCount++;
    if (visitedGeometryCount > limits.maxGeometryCount) throw fbxError("FBX_GEOMETRY_COUNT_EXCEEDED");
    const decoded = decodeFBXGeometry(geomObj.node, limits);
    geometryCache.set(geomObj.id, decoded);
    return decoded;
  }

  // --- Scene walk ---

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const segments: FBXViewerSegment[] = [];

  let hasAnySourceNormals = false;
  let hasAnyFallbackNormals = false;
  let hasAnyUVs = false;
  let hasAnyExtraUVSet = false;
  let hasAnyColors = false;
  let hasInvalidMaterialReference = false;
  const hasLayerElementFailure: Record<"mapping" | "reference" | "index", boolean> = { mapping: false, reference: false, index: false };
  let controlPointTotal = 0;
  let polygonTotal = 0;
  let renderedTriangleCount = 0;
  let skippedPolygonTotal = 0;
  let modelCount = 0;
  let meshInstanceCount = 0;
  let cornerCount = 0;

  function emitLayerFailure(failure: "unsupported-mapping-mode" | "unsupported-reference-mode" | "invalid-index" | null): void {
    if (failure === "unsupported-mapping-mode") hasLayerElementFailure.mapping = true;
    else if (failure === "unsupported-reference-mode") hasLayerElementFailure.reference = true;
    else if (failure === "invalid-index") hasLayerElementFailure.index = true;
  }

  function visitModel(node: FBXModelTreeNode, parentWorld: Mat4, depth: number, path: number[]): void {
    const modelIndex = modelCount;
    modelCount++;
    if (modelCount > limits.maxModelCount) throw fbxError("FBX_MODEL_COUNT_EXCEEDED");

    const props70 = readProperties70(node.object.node);
    const t = readNodeTransformProperties(props70);
    if (t.inheritType !== 0) addWarning("unsupported-inherit-type");
    if (t.rotationOrder === 6) addWarning("unsupported-rotation-order");

    const local = validateFiniteMatrix(composeLocalMatrix(t));
    const world = validateFiniteMatrix(multiplyMat4(parentWorld, local));

    const geometryObjs = connectedObjectsOfClass(graph, node.object.id, "Geometry");
    const materialObjs = connectedObjectsOfClass(graph, node.object.id, "Material");
    const modelMaterialIndices = materialObjs.map((m) => resolveMaterialObjectIndex(m));

    for (const geomObj of geometryObjs) {
      const decoded = getDecodedGeometry(geomObj);
      if (!decoded) continue;

      controlPointTotal += decoded.controlPointCount;
      polygonTotal += decoded.polygonCount;
      skippedPolygonTotal += decoded.skippedDegeneratePolygons;
      if (decoded.skippedDegeneratePolygons > 0) addWarning("degenerate-polygons-skipped");

      const geometric = composeGeometricMatrix(t);
      const meshWorld = validateFiniteMatrix(multiplyMat4(world, geometric));
      const reflected = determinantSign3x3(meshWorld) < 0;
      const meshNormalMatrix = computeNormalMatrix(meshWorld);

      const normalLayerNode = findChild(geomObj.node, "LayerElementNormal");
      const normalLayer = normalLayerNode ? readLayerElementSource(normalLayerNode, "Normals", "NormalsIndex", 3) : null;

      const uvLayerNodes = geomObj.node.children.filter((c) => c.name === "LayerElementUV");
      const uvLayer = uvLayerNodes.length > 0 ? readLayerElementSource(uvLayerNodes[0], "UV", "UVIndex", 2) : null;
      if (uvLayerNodes.length > 1) hasAnyExtraUVSet = true;

      const colorLayerNode = findChild(geomObj.node, "LayerElementColor");
      const colorLayer = colorLayerNode ? readLayerElementSource(colorLayerNode, "Colors", "ColorIndex", 4) : null;

      const materialLayerNode = findChild(geomObj.node, "LayerElementMaterial");
      const materialLayer = materialLayerNode ? readIntegerLayerElement(materialLayerNode, "Materials") : null;

      const fallbackNormals = computeFallbackNormalsPerControlPoint(decoded);

      const segIndexStart = cornerCount;
      const segBounds = freshBounds();
      let segMaterialIndex: number | null = null;

      for (const tri of decoded.triangles) {
        renderedTriangleCount++;
        if (renderedTriangleCount > limits.maxTriangles) throw fbxError("FBX_TRIANGLE_LIMIT_EXCEEDED");

        let [i0, i1, i2] = [0, 1, 2] as [number, number, number];
        if (reflected) [i1, i2] = [i2, i1];
        const cornerOrder: [number, number, number] = [i0, i1, i2];

        for (const k of cornerOrder) {
          const cpIndex = tri.controlPointIndices[k];
          const cornerIndex = tri.cornerIndices[k];
          const localPos: [number, number, number] = [decoded.controlPoints[cpIndex * 3], decoded.controlPoints[cpIndex * 3 + 1], decoded.controlPoints[cpIndex * 3 + 2]];
          const meshPos = transformPoint(meshWorld, localPos);
          if (!Number.isFinite(meshPos[0]) || !Number.isFinite(meshPos[1]) || !Number.isFinite(meshPos[2])) throw fbxError("FBX_TRANSFORM_INVALID");
          const worldPos = transformPoint(scaledAxisMat, meshPos);
          positions.push(worldPos[0], worldPos[1], worldPos[2]);
          extendBounds(segBounds, worldPos[0], worldPos[1], worldPos[2]);

          let localNormal: [number, number, number];
          if (normalLayer) {
            const res = resolveLayerElementValue(normalLayer, cpIndex, cornerIndex, tri.polygonIndex);
            emitLayerFailure(res.failure);
            if (res.values) {
              localNormal = normalizeVec3(res.values);
              hasAnySourceNormals = true;
            } else {
              localNormal = [fallbackNormals[cpIndex * 3], fallbackNormals[cpIndex * 3 + 1], fallbackNormals[cpIndex * 3 + 2]];
              hasAnyFallbackNormals = true;
            }
          } else {
            localNormal = [fallbackNormals[cpIndex * 3], fallbackNormals[cpIndex * 3 + 1], fallbackNormals[cpIndex * 3 + 2]];
            hasAnyFallbackNormals = true;
          }
          const meshNormal = meshNormalMatrix ? applyNormalMatrix(meshNormalMatrix, localNormal[0], localNormal[1], localNormal[2]) : localNormal;
          const worldNormal = normalMatrixForNormalization ? applyNormalMatrix(normalMatrixForNormalization, meshNormal[0], meshNormal[1], meshNormal[2]) : meshNormal;
          normals.push(worldNormal[0], worldNormal[1], worldNormal[2]);

          if (uvLayer) {
            const res = resolveLayerElementValue(uvLayer, cpIndex, cornerIndex, tri.polygonIndex);
            emitLayerFailure(res.failure);
            if (res.values) {
              uvs.push(res.values[0], res.values[1]);
              hasAnyUVs = true;
            } else {
              uvs.push(0, 0);
            }
          } else {
            uvs.push(0, 0);
          }

          if (colorLayer) {
            const res = resolveLayerElementValue(colorLayer, cpIndex, cornerIndex, tri.polygonIndex);
            emitLayerFailure(res.failure);
            if (res.values) {
              colors.push(res.values[0], res.values[1], res.values[2], res.values[3] ?? 1);
              hasAnyColors = true;
            } else {
              colors.push(1, 1, 1, 1);
            }
          } else {
            colors.push(1, 1, 1, 1);
          }

          cornerCount++;
        }

        // Material index for this triangle's polygon — attaches to the SEGMENT (one material per Model/Geometry visit in this phase's own scope), the first triangle's resolution wins per segment.
        if (segMaterialIndex === null) {
          if (materialLayer && modelMaterialIndices.length > 0) {
            const res = resolveMaterialIndex(materialLayer, tri.polygonIndex);
            emitLayerFailure(res.failure);
            const localIdx = res.values ? res.values[0] : 0;
            if (localIdx >= 0 && localIdx < modelMaterialIndices.length) {
              segMaterialIndex = modelMaterialIndices[localIdx];
            } else {
              hasInvalidMaterialReference = true;
              segMaterialIndex = modelMaterialIndices[0] ?? null;
            }
          } else if (modelMaterialIndices.length > 0) {
            segMaterialIndex = modelMaterialIndices[0];
          }
        }
      }

      meshInstanceCount++;
      if (segments.length >= limits.maxSegments) throw fbxError("FBX_OUTPUT_TOO_LARGE");
      segments.push({
        modelName: node.object.name || null,
        modelPath: path,
        materialIndex: segMaterialIndex,
        indexStart: segIndexStart,
        indexCount: cornerCount - segIndexStart,
        bounds: finalizeBounds(segBounds),
      });
    }

    const nextPath = [...path, modelIndex];
    for (const child of node.children) visitModel(child, world, depth + 1, nextPath);
  }

  for (const root of modelRoots) visitModel(root, IDENTITY_MAT4, 0, []);

  if (positions.length === 0) throw fbxError("FBX_VIEWER_NO_RENDERABLE_GEOMETRY");
  if (hasAnyFallbackNormals) addWarning("geometric-fallback-normals");
  if (hasAnyExtraUVSet) addWarning("additional-uv-sets-not-rendered");
  if (hasLayerElementFailure.mapping) addWarning("layer-element-unsupported-mapping");
  if (hasLayerElementFailure.reference) addWarning("layer-element-unsupported-reference");
  if (hasLayerElementFailure.index) addWarning("layer-element-invalid-index");
  if (hasInvalidMaterialReference) addWarning("material-reference-invalid");

  const positionArray = Float32Array.from(positions);
  const indices = new Uint32Array(positionArray.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  const totalOutputBytes = positionArray.byteLength * 3 + indices.byteLength + images.reduce((sum, img) => sum + (img?.bytes.byteLength ?? 0), 0);
  if (totalOutputBytes > limits.maxOutputBytes) throw fbxError("FBX_OUTPUT_TOO_LARGE");

  return {
    positions: positionArray,
    normals: Float32Array.from(normals),
    uvs: hasAnyUVs ? Float32Array.from(uvs) : undefined,
    colors: hasAnyColors ? Float32Array.from(colors) : undefined,
    indices,
    segments,
    materials,
    images,
    boundsModelUnits: computeBoundsFromFlat(positionArray),
    fbxVersion: parsedVersion,
    encoding: "binary",
    recordLayout: uses64BitRecords ? "64-bit" : "32-bit",
    creator: doc.creator,
    modelCount,
    geometryCount: [...geometryCache.values()].filter((g) => g !== null).length,
    meshInstanceCount,
    materialCount: materials.length,
    embeddedTextureCount,
    externalTextureReferenceCount,
    controlPointCount: controlPointTotal,
    polygonCount: polygonTotal,
    renderedTriangleCount,
    skippedPolygonCount: skippedPolygonTotal,
    hasSourceNormals: hasAnySourceNormals,
    hasUVs: hasAnyUVs,
    hasVertexColors: hasAnyColors,
    sourceUnitScaleFactor: globalSettings.unitScaleFactor,
    normalizedToMeters,
    axisSystemKnown,
    unsupportedFeatures: [...unsupportedFeatures],
    unrecognizedObjectClassCount,
    warnings,
  };
}

function computeBoundsFromFlat(positions: Float32Array): STLBounds {
  const b = freshBounds();
  for (let i = 0; i < positions.length; i += 3) extendBounds(b, positions[i], positions[i + 1], positions[i + 2]);
  return finalizeBounds(b);
}

/** Convenience wrapper for callers that don't need the parse/interpret/resolve stages split (tests, and anywhere outside the worker's staged pipeline). */
export function resolveFBXViewerScene(buffer: ArrayBuffer, limits: FBXViewerLimits = DEFAULT_FBX_VIEWER_LIMITS): FBXViewerResult {
  const parsed = parseFBXBinary(buffer, limits);
  const doc = interpretFBXDocument(parsed.version, parsed.uses64BitRecords, parsed.nodes, limits);
  const graph = buildConnectionGraph(doc);
  return resolveFBXViewerSceneFromDocument(parsed.version, parsed.uses64BitRecords, doc, graph, limits);
}

export function resolveFBXViewerPackage(buffer: ArrayBuffer, limits: FBXViewerLimits = DEFAULT_FBX_VIEWER_LIMITS): FBXViewerResult {
  return resolveFBXViewerScene(buffer, limits);
}
