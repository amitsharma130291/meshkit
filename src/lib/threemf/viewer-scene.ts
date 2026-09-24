/**
 * Viewer scene resolution: walks Build → build item → component instance →
 * ... → mesh object exactly like `resolveScene()` (the converter's own
 * pipeline) — same cycle detection, same depth ceiling, same instance
 * ceiling, same inner-then-outer transform composition, same
 * reflected-winding fix, same once-only unit conversion, all reused
 * directly from `transforms.ts`/`units.ts`. The one real difference: this
 * walk also records one `ThreeMFViewerSegment` per mesh-leaf visit (so
 * `segments.length === resolvedInstanceCount` always) and resolves a
 * per-corner color for every triangle, neither of which the converter's
 * flat triangle-soup output has any use for.
 */
import { computeBounds } from "../stl/bounds";
import { computeFaceNormal } from "../stl/normals";
import { threeMFError } from "./errors";
import { openThreeMFPackage } from "./package";
import { findPrimaryModelPath } from "./relationships";
import { applyTransform, composeTransforms, transformDeterminantSign } from "./transforms";
import { millimeterFactorFor } from "./units";
import { resolvePropertyColor, srgbChannelToLinear, type ParsedColor } from "./viewer-colors";
import { parseThreeMFViewerModel } from "./viewer-resources";
import type { ThreeMFTransform } from "./types";
import {
  DEFAULT_THREEMF_VIEWER_LIMITS,
  type ThreeMFTransformSummary,
  type ThreeMFViewerLimits,
  type ThreeMFViewerResult,
  type ThreeMFViewerSegment,
  type ThreeMFViewerWarning,
  type ThreeMFViewerWarningCode,
} from "./viewer-types";
import type { ThreeMFViewerMeshObject, ThreeMFViewerModel } from "./viewer-resources";

/** A restrained neutral gray (matches the app's other neutral model color, #c7c2de) for any corner with no resolved color — sRGB-decoded once, here, rather than per-corner. */
const NEUTRAL_LINEAR: [number, number, number] = [
  srgbChannelToLinear(0xc7 / 255),
  srgbChannelToLinear(0xc2 / 255),
  srgbChannelToLinear(0xde / 255),
];

const FEATURE_TO_WARNING: Record<string, ThreeMFViewerWarningCode> = {
  texture2d: "textures-not-rendered",
  beamlattice: "beam-lattice-not-rendered",
  slicestack: "slice-stack-not-rendered",
  slice: "slice-stack-not-rendered",
  keystore: "unsupported-extension-content",
  resourcedata: "unsupported-extension-content",
  volumetricstack: "unsupported-extension-content",
  volumedata: "unsupported-extension-content",
  compositematerials: "unsupported-extension-content",
  multiproperties: "unsupported-extension-content",
};

const WARNING_MESSAGES: Record<ThreeMFViewerWarningCode, string> = {
  "textures-not-rendered": "This file references texture resources. MeshWrench never fetches or decodes them — affected surfaces use their embedded base color, or a neutral material.",
  "beam-lattice-not-rendered": "This file includes a beam lattice, which this viewer doesn't render.",
  "slice-stack-not-rendered": "This file includes slice-stack data, which this viewer doesn't render.",
  "unsupported-extension-content": "This file uses an extension (production, volumetric or secure-content) this viewer doesn't render. Core mesh geometry is still shown.",
  "color-reference-invalid": "Some color or material references in this file don't resolve to a valid entry — affected surfaces use a neutral fallback material.",
  "cross-part-reference-skipped": "This file references geometry in another package part. MeshWrench only reads the primary model part, so that reference was skipped.",
  "alpha-not-rendered": "This file's colors include transparency information, which this viewer doesn't render — all surfaces are shown fully opaque.",
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

function finalizeBounds(bounds: MutableBounds) {
  if (!Number.isFinite(bounds.min[0])) {
    return { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
  }
  const size: [number, number, number] = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  return { min: bounds.min, max: bounds.max, size, center };
}

const IDENTITY_EPS = 1e-9;

function summarizeTransform(t: ThreeMFTransform): ThreeMFTransformSummary {
  if (transformDeterminantSign(t) < 0) return "reflected";
  const linearIsIdentity =
    Math.abs(t[0] - 1) < IDENTITY_EPS &&
    Math.abs(t[1]) < IDENTITY_EPS &&
    Math.abs(t[2]) < IDENTITY_EPS &&
    Math.abs(t[3]) < IDENTITY_EPS &&
    Math.abs(t[4] - 1) < IDENTITY_EPS &&
    Math.abs(t[5]) < IDENTITY_EPS &&
    Math.abs(t[6]) < IDENTITY_EPS &&
    Math.abs(t[7]) < IDENTITY_EPS &&
    Math.abs(t[8] - 1) < IDENTITY_EPS;
  const translationIsZero = Math.abs(t[9]) < IDENTITY_EPS && Math.abs(t[10]) < IDENTITY_EPS && Math.abs(t[11]) < IDENTITY_EPS;
  if (linearIsIdentity && translationIsZero) return "identity";
  if (linearIsIdentity) return "translated";
  return "transformed";
}

function describeColorRef(pid: string | undefined, pindex: number | undefined): string | null {
  if (pid === undefined || pindex === undefined) return null;
  return `${pid}:${pindex}`;
}

export function resolveViewerScene(
  model: ThreeMFViewerModel,
  limits: ThreeMFViewerLimits = DEFAULT_THREEMF_VIEWER_LIMITS,
  packageEntryCount = 0,
): ThreeMFViewerResult {
  if (model.buildItems.length === 0) {
    throw threeMFError("THREEMF_BUILD_EMPTY");
  }

  const unitFactor = millimeterFactorFor(model.unit);
  const positions: number[] = [];
  const normals: number[] = [];
  const colorsBuffer: number[] = [];
  const segments: ThreeMFViewerSegment[] = [];

  let triangleCount = 0;
  let resolvedInstanceCount = 0;
  let anyColorResolved = false;
  let hasInvalidColorReference = false;
  let hasTransparentColors = false;
  let crossPartSkipped = model.crossPartReferenceCount > 0;

  let currentSegmentBounds: MutableBounds = freshBounds();

  function resolveCornerColor(pid: string | undefined, pindex: number | undefined): [number, number, number] {
    const resolution = resolvePropertyColor(model.colorResources, pid, pindex);
    if (resolution.kind === "color") {
      anyColorResolved = true;
      const c: ParsedColor = resolution.color;
      if (c.alpha < 1) hasTransparentColors = true;
      return [srgbChannelToLinear(c.r), srgbChannelToLinear(c.g), srgbChannelToLinear(c.b)];
    }
    if (resolution.kind === "invalid") hasInvalidColorReference = true;
    return NEUTRAL_LINEAR;
  }

  function transformVertex(vertices: Float64Array, index: number, transform: ThreeMFTransform): [number, number, number] {
    const x = vertices[index * 3];
    const y = vertices[index * 3 + 1];
    const z = vertices[index * 3 + 2];
    const [tx, ty, tz] = applyTransform(transform, x, y, z);
    return [tx * unitFactor, ty * unitFactor, tz * unitFactor];
  }

  function emitTriangle(mesh: ThreeMFViewerMeshObject, triangleIndex: number, transform: ThreeMFTransform): void {
    if (triangleCount >= limits.maxTriangles) throw threeMFError("THREEMF_COMPLEXITY_LIMIT");

    let i0 = mesh.triangleIndices[triangleIndex * 3];
    let i1 = mesh.triangleIndices[triangleIndex * 3 + 1];
    let i2 = mesh.triangleIndices[triangleIndex * 3 + 2];

    const props = mesh.triangleProps[triangleIndex];
    const pid = props.pid ?? mesh.pid;
    let colorA = resolveCornerColor(pid, props.p1 ?? mesh.pindex);
    let colorB = resolveCornerColor(pid, props.p2 ?? mesh.pindex);
    let colorC = resolveCornerColor(pid, props.p3 ?? mesh.pindex);

    if (transformDeterminantSign(transform) < 0) {
      // Same reflection fix as resolveScene(): swap two vertices to keep
      // winding (and the computed face normal) outward-facing. Swap the
      // matching per-corner colors alongside, so p2/p3 stay attached to
      // the same rendered corner as their geometry after the swap.
      const swapIndex = i1;
      i1 = i2;
      i2 = swapIndex;
      const swapColor = colorB;
      colorB = colorC;
      colorC = swapColor;
    }

    const p0 = transformVertex(mesh.vertices, i0, transform);
    const p1 = transformVertex(mesh.vertices, i1, transform);
    const p2 = transformVertex(mesh.vertices, i2, transform);

    for (const p of [p0, p1, p2]) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
        throw threeMFError("THREEMF_VERTEX_INVALID");
      }
    }

    const normal = computeFaceNormal(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);

    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
    colorsBuffer.push(...colorA, ...colorB, ...colorC);

    extendBounds(currentSegmentBounds, p0[0], p0[1], p0[2]);
    extendBounds(currentSegmentBounds, p1[0], p1[1], p1[2]);
    extendBounds(currentSegmentBounds, p2[0], p2[1], p2[2]);

    triangleCount++;
  }

  function resolveObject(
    objectId: string,
    transform: ThreeMFTransform,
    depth: number,
    ancestry: ReadonlySet<string>,
    buildItemIndex: number,
    componentPath: number[],
  ): void {
    if (depth > limits.maxComponentDepth) throw threeMFError("THREEMF_COMPONENT_DEPTH_EXCEEDED");
    if (ancestry.has(objectId)) throw threeMFError("THREEMF_COMPONENT_CYCLE");
    const object = model.objects.get(objectId);
    if (!object) throw threeMFError("THREEMF_OBJECT_MISSING");

    if (object.kind === "mesh") {
      resolvedInstanceCount++;
      if (resolvedInstanceCount > limits.maxComponentInstances) throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
      if (segments.length >= limits.maxSegments) throw threeMFError("THREEMF_VIEWER_SEGMENT_LIMIT");

      const triangleStart = triangleCount;
      currentSegmentBounds = freshBounds();
      const triCount = object.triangleIndices.length / 3;
      for (let t = 0; t < triCount; t++) {
        emitTriangle(object, t, transform);
      }

      segments.push({
        buildItemIndex,
        meshObjectId: objectId,
        componentPath: componentPath.slice(),
        triangleStart,
        triangleCount: triangleCount - triangleStart,
        transformSummary: summarizeTransform(transform),
        displayName: object.name,
        colorResourceRef: describeColorRef(object.pid, object.pindex),
        bounds: finalizeBounds(currentSegmentBounds),
      });
      return;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(objectId);
    let componentIndex = 0;
    for (const component of object.components) {
      componentIndex++;
      if (component.crossPart) {
        crossPartSkipped = true;
        continue;
      }
      const combined = composeTransforms(component.transform, transform);
      resolveObject(component.objectId, combined, depth + 1, nextAncestry, buildItemIndex, [...componentPath, componentIndex]);
    }
  }

  model.buildItems.forEach((item, index) => {
    if (item.crossPart) {
      crossPartSkipped = true;
      return;
    }
    resolveObject(item.objectId, item.transform, 0, new Set(), index, []);
  });

  if (positions.length === 0) {
    throw threeMFError("THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY");
  }

  const positionArray = Float32Array.from(positions);
  const colorArrayBytes = colorsBuffer.length * Float32Array.BYTES_PER_ELEMENT;
  if (anyColorResolved && colorArrayBytes > limits.maxColorArrayBytes) {
    throw threeMFError("THREEMF_VIEWER_COLOR_LIMIT");
  }

  let meshObjectCount = 0;
  let componentObjectCount = 0;
  let sourceVertexCount = 0;
  for (const object of model.objects.values()) {
    if (object.kind === "mesh") {
      meshObjectCount++;
      sourceVertexCount += object.vertices.length / 3;
    } else {
      componentObjectCount++;
    }
  }

  const warnings: ThreeMFViewerWarning[] = [];
  const pushWarning = (code: ThreeMFViewerWarningCode) => {
    if (!warnings.some((w) => w.code === code)) warnings.push({ code, message: WARNING_MESSAGES[code] });
  };
  for (const feature of model.unsupportedFeatures) {
    const code = FEATURE_TO_WARNING[feature];
    if (code) pushWarning(code);
  }
  if (crossPartSkipped) pushWarning("cross-part-reference-skipped");
  if (hasInvalidColorReference) pushWarning("color-reference-invalid");
  if (hasTransparentColors) pushWarning("alpha-not-rendered");

  const baseMaterialEntryCount = Array.from(model.colorResources.basematerials.values()).reduce((sum, list) => sum + list.length, 0);
  const colorEntryCount = Array.from(model.colorResources.colorgroups.values()).reduce((sum, list) => sum + list.length, 0);

  return {
    packageEntryCount,
    positions: positionArray,
    normals: Float32Array.from(normals),
    colors: anyColorResolved ? Float32Array.from(colorsBuffer) : undefined,
    hasEmbeddedColors: anyColorResolved,
    hasTransparentColors,
    triangleCount,
    sourceVertexCount,
    meshObjectCount,
    componentObjectCount,
    buildItemCount: model.buildItems.length,
    resolvedInstanceCount,
    declaredUnit: model.unit,
    millimeterScale: unitFactor,
    boundsMillimeters: computeBounds(positionArray),
    segments,
    metadata: model.metadata,
    colorResources: {
      baseMaterialGroupCount: model.colorResources.basematerials.size,
      baseMaterialEntryCount,
      colorGroupCount: model.colorResources.colorgroups.size,
      colorEntryCount,
      textureResourceCount: model.textureResourceCount,
    },
    warnings,
  };
}

/** Convenience wrapper for callers that don't need the parse/resolve stages split (tests, and anywhere outside the worker's staged pipeline). `packageEntryCount` is 0 when resolving bare model XML with no package in hand. */
export function resolveThreeMFViewerScene(
  xml: string,
  limits: ThreeMFViewerLimits = DEFAULT_THREEMF_VIEWER_LIMITS,
  packageEntryCount = 0,
): ThreeMFViewerResult {
  const model = parseThreeMFViewerModel(xml, limits);
  return resolveViewerScene(model, limits, packageEntryCount);
}

/** Full pipeline: open the package, locate the primary model part, and resolve the viewer scene — mirrors `convertThreeMFPackage()` in convert.ts but ends at `ThreeMFViewerResult`, never `serializeBinarySTL()`. */
export function resolveThreeMFViewerPackage(buffer: ArrayBuffer, limits: ThreeMFViewerLimits = DEFAULT_THREEMF_VIEWER_LIMITS): ThreeMFViewerResult {
  const pkg = openThreeMFPackage(buffer, limits);
  const modelPath = findPrimaryModelPath(pkg);
  const modelBytes = pkg.readEntry(modelPath);

  if (modelBytes.byteLength > limits.maxModelXmlBytes) {
    throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
  }

  const xml = new TextDecoder("utf-8", { fatal: false }).decode(modelBytes);
  return resolveThreeMFViewerScene(xml, limits, pkg.entryNames.size);
}
