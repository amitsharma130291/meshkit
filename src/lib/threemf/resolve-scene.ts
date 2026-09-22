import { computeBounds } from "../stl/bounds";
import { computeFaceNormal } from "../stl/normals";
import { threeMFError } from "./errors";
import { applyTransform, composeTransforms, transformDeterminantSign } from "./transforms";
import { millimeterFactorFor } from "./units";
import type { ConversionWarning, ResolvedScene, ThreeMFLimits, ThreeMFMeshObject, ThreeMFModel, ThreeMFTransform } from "./types";

const WARNING_COPY: Record<ConversionWarning["code"], string> = {
  "colors-not-preserved": "This 3MF file includes color information, which STL cannot store.",
  "materials-not-preserved": "This 3MF file includes material definitions, which STL cannot store.",
  "textures-not-preserved": "This 3MF file includes textures, which STL cannot store.",
  "metadata-not-preserved": "This 3MF file includes metadata, which is not carried over to STL.",
};

const FEATURE_TO_WARNING: Record<string, ConversionWarning["code"]> = {
  colorgroup: "colors-not-preserved",
  basematerials: "materials-not-preserved",
  texture2d: "textures-not-preserved",
  metadata: "metadata-not-preserved",
};

/**
 * Walks every <build><item>, resolving (possibly nested) component
 * references down to mesh leaves, composing transforms in
 * inner-then-outer order, converting to millimeters, and flattening
 * everything into one triangle soup ready for STL serialization/preview.
 */
export function resolveScene(model: ThreeMFModel, limits: ThreeMFLimits): ResolvedScene {
  if (model.buildItems.length === 0) {
    throw threeMFError("THREEMF_BUILD_EMPTY");
  }

  const unitFactor = millimeterFactorFor(model.unit);
  const positions: number[] = [];
  const normals: number[] = [];
  const visitedMeshObjectIds = new Set<string>();
  let componentInstanceCount = 0;
  let triangleCount = 0;

  const emitTriangle = (mesh: ThreeMFMeshObject, triangleIndex: number, transform: ThreeMFTransform): void => {
    if (triangleCount >= limits.maxTriangles) {
      throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
    }

    let i0 = mesh.triangleIndices[triangleIndex * 3];
    let i1 = mesh.triangleIndices[triangleIndex * 3 + 1];
    let i2 = mesh.triangleIndices[triangleIndex * 3 + 2];

    if (transformDeterminantSign(transform) < 0) {
      // A reflecting transform mirrors the triangle — swap two vertices so
      // winding (and therefore the computed face normal) stays consistent
      // with the rest of the scene instead of pointing inward.
      const swap = i1;
      i1 = i2;
      i2 = swap;
    }

    const p0 = transformVertex(mesh.vertices, i0, transform, unitFactor);
    const p1 = transformVertex(mesh.vertices, i1, transform, unitFactor);
    const p2 = transformVertex(mesh.vertices, i2, transform, unitFactor);

    for (const p of [p0, p1, p2]) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
        throw threeMFError("THREEMF_VERTEX_INVALID");
      }
    }

    const normal = computeFaceNormal(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);

    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
    triangleCount++;
  };

  const resolveObject = (objectId: string, transform: ThreeMFTransform, depth: number, ancestry: ReadonlySet<string>): void => {
    if (depth > limits.maxComponentDepth) {
      throw threeMFError("THREEMF_COMPONENT_DEPTH_EXCEEDED");
    }
    if (ancestry.has(objectId)) {
      throw threeMFError("THREEMF_COMPONENT_CYCLE");
    }
    const object = model.objects.get(objectId);
    if (!object) {
      throw threeMFError("THREEMF_OBJECT_MISSING");
    }

    if (object.kind === "mesh") {
      componentInstanceCount++;
      if (componentInstanceCount > limits.maxComponentInstances) {
        throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
      }
      visitedMeshObjectIds.add(objectId);
      const triCount = object.triangleIndices.length / 3;
      for (let t = 0; t < triCount; t++) {
        emitTriangle(object, t, transform);
      }
      return;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(objectId);
    for (const component of object.components) {
      const combined = composeTransforms(component.transform, transform);
      resolveObject(component.objectId, combined, depth + 1, nextAncestry);
    }
  };

  for (const item of model.buildItems) {
    resolveObject(item.objectId, item.transform, 0, new Set());
  }

  if (positions.length === 0) {
    throw threeMFError("THREEMF_GEOMETRY_EMPTY");
  }

  const positionArray = Float32Array.from(positions);
  const warnings: ConversionWarning[] = [];
  for (const feature of model.unsupportedFeatures) {
    const code = FEATURE_TO_WARNING[feature];
    if (code && !warnings.some((w) => w.code === code)) {
      warnings.push({ code, message: WARNING_COPY[code] });
    }
  }

  return {
    positions: positionArray,
    normals: Float32Array.from(normals),
    triangleCount,
    objectCount: visitedMeshObjectIds.size,
    buildItemCount: model.buildItems.length,
    componentInstanceCount,
    bounds: computeBounds(positionArray),
    warnings,
  };
}

function transformVertex(
  vertices: Float64Array,
  index: number,
  transform: ThreeMFTransform,
  unitFactor: number,
): [number, number, number] {
  const x = vertices[index * 3];
  const y = vertices[index * 3 + 1];
  const z = vertices[index * 3 + 2];
  const [tx, ty, tz] = applyTransform(transform, x, y, z);
  return [tx * unitFactor, ty * unitFactor, tz * unitFactor];
}
