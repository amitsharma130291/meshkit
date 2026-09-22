/**
 * Scene traversal and flattening: selects the scene to export, walks its
 * node graph composing world transforms, and emits every decoded
 * primitive's triangles — transformed, unit-scaled, winding-corrected for
 * reflection, and filtered for degenerate (zero-area) results — into one
 * flat triangle soup ready for STL serialization/preview.
 */
import { computeBounds } from "../stl/bounds";
import { computeFaceNormal } from "../stl/normals";
import { glbError } from "./errors";
import { composeTRS, determinantSign3x3, isFiniteMat4, multiplyMat4, transformPoint } from "./transforms";
import { IDENTITY_MAT4, METERS_TO_MILLIMETERS } from "./types";
import type { ConversionWarning, DecodedMesh, GLBLimits, GLTFDocument, GLTFNode, Mat4, ResolvedGLBScene } from "./types";

const WARNING_COPY: Record<ConversionWarning["code"], string> = {
  "materials-not-preserved": "This GLB file includes materials, which STL can't store.",
  "textures-not-preserved": "This GLB file includes textures or UV coordinates, which STL can't store.",
  "vertex-colors-not-preserved": "This GLB file includes vertex colors, which STL can't store.",
  "animations-not-preserved": "This GLB file includes animations, which aren't applied — only the base pose converts.",
  "skins-not-preserved": "This GLB file includes a skin (rig), which isn't applied — only the undeformed base mesh converts.",
  "morph-targets-not-preserved": "This GLB file includes morph targets, which aren't applied — only the base shape converts.",
  "unsupported-primitives-skipped": "This GLB file includes point or line geometry, which STL can't represent and was skipped.",
  "degenerate-triangles-skipped": "Some triangles in this file had no measurable area and were skipped.",
};

/** Per the spec's default-scene fallback rule: `scenes[0]` when `scene` is omitted but a `scenes` array exists. */
function selectRootNodeIndices(doc: GLTFDocument): { rootNodes: number[]; sceneName?: string } {
  if (doc.scenes.length > 0) {
    const sceneIndex = doc.scene ?? 0;
    const scene = doc.scenes[sceneIndex];
    if (!scene) throw glbError("GLB_SCENE_MISSING");
    for (const nodeIndex of scene.nodes) {
      if (!doc.nodes[nodeIndex]) throw glbError("GLB_NODE_INVALID");
    }
    return { rootNodes: scene.nodes, sceneName: scene.name };
  }

  // No `scenes` array at all: a documented, tested fallback — identify
  // nodes that are never referenced as anyone's child and treat those as
  // an implicit scene, rather than blindly exporting every node resource.
  if (doc.nodes.length === 0) throw glbError("GLB_SCENE_MISSING");
  const referenced = new Set<number>();
  for (const node of doc.nodes) {
    for (const child of node.children) referenced.add(child);
  }
  const rootNodes = doc.nodes.map((_, i) => i).filter((i) => !referenced.has(i));
  if (rootNodes.length === 0) {
    // Every node is referenced as a child — with no `scenes` array to
    // anchor a starting point, this is a structurally invalid file, not a
    // "silently export everything" situation.
    throw glbError("GLB_SCENE_MISSING");
  }
  return { rootNodes };
}

function localMatrixForNode(node: GLTFNode): Mat4 {
  if (node.matrix) {
    const m = node.matrix as unknown as Mat4;
    if (!isFiniteMat4(m)) throw glbError("GLB_TRANSFORM_INVALID");
    return m;
  }
  const t = (node.translation as [number, number, number] | undefined) ?? [0, 0, 0];
  const r = (node.rotation as [number, number, number, number] | undefined) ?? [0, 0, 0, 1];
  const s = (node.scale as [number, number, number] | undefined) ?? [1, 1, 1];
  return composeTRS(t, r, s);
}

export function resolveGLBScene(
  doc: GLTFDocument,
  decoded: DecodedMesh[],
  limits: GLBLimits,
  skippedUnsupportedPrimitiveCount: number,
): ResolvedGLBScene {
  const { rootNodes, sceneName } = selectRootNodeIndices(doc);

  const positions: number[] = [];
  const normals: number[] = [];
  const visitedMeshIndices = new Set<number>();
  let nodeInstanceCount = 0;
  let triangleCount = 0;
  let skippedDegenerateTriangles = 0;
  let sawTexCoords = false;
  let sawVertexColors = false;
  let sawMaterial = false;
  let sawMorphTargets = false;

  const emitPrimitiveTriangles = (primitive: DecodedMesh["primitives"][number], worldMatrix: Mat4): void => {
    const reflected = determinantSign3x3(worldMatrix) < 0;
    const triCount = primitive.triangleIndices.length / 3;

    for (let t = 0; t < triCount; t++) {
      if (triangleCount >= limits.maxTriangles) throw glbError("GLB_COMPLEXITY_LIMIT");

      let i0 = primitive.triangleIndices[t * 3];
      let i1 = primitive.triangleIndices[t * 3 + 1];
      let i2 = primitive.triangleIndices[t * 3 + 2];
      if (reflected) {
        // A reflecting transform mirrors the triangle — swap two vertices
        // so winding (and the computed face normal) stays outward-facing
        // instead of flipping inward.
        const swap = i1;
        i1 = i2;
        i2 = swap;
      }

      const p0 = transformAndScale(worldMatrix, primitive.positions, i0);
      const p1 = transformAndScale(worldMatrix, primitive.positions, i1);
      const p2 = transformAndScale(worldMatrix, primitive.positions, i2);

      for (const p of [p0, p1, p2]) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
          throw glbError("GLB_TRANSFORM_INVALID");
        }
      }

      const normal = computeFaceNormal(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
        // Zero-area after transformation — documented policy: skip, count,
        // warn; never silently invent a direction for it.
        skippedDegenerateTriangles++;
        continue;
      }

      positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
      triangleCount++;
    }
  };

  const visitNode = (nodeIndex: number, parentWorld: Mat4, depth: number, ancestry: ReadonlySet<number>): void => {
    if (depth > limits.maxSceneDepth) throw glbError("GLB_NODE_DEPTH_EXCEEDED");
    if (ancestry.has(nodeIndex)) throw glbError("GLB_NODE_CYCLE");

    const node = doc.nodes[nodeIndex];
    if (!node) throw glbError("GLB_NODE_INVALID");

    const worldMatrix = multiplyMat4(parentWorld, localMatrixForNode(node));

    if (node.mesh !== undefined) {
      const mesh = decoded[node.mesh];
      if (!mesh) throw glbError("GLB_NODE_INVALID");

      nodeInstanceCount++;
      if (nodeInstanceCount > limits.maxSceneInstances) throw glbError("GLB_COMPLEXITY_LIMIT");

      if (mesh.primitives.length > 0) visitedMeshIndices.add(node.mesh);

      for (const primitive of mesh.primitives) {
        sawTexCoords = sawTexCoords || primitive.hasTexCoords;
        sawVertexColors = sawVertexColors || primitive.hasVertexColors;
        sawMaterial = sawMaterial || primitive.hasMaterial;
        sawMorphTargets = sawMorphTargets || primitive.hasMorphTargets;
        emitPrimitiveTriangles(primitive, worldMatrix);
      }
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeIndex);
    for (const childIndex of node.children) {
      visitNode(childIndex, worldMatrix, depth + 1, nextAncestry);
    }
  };

  for (const rootIndex of rootNodes) {
    visitNode(rootIndex, IDENTITY_MAT4, 0, new Set());
  }

  if (positions.length === 0) {
    throw glbError("GLB_EMPTY_GEOMETRY");
  }

  const positionArray = Float32Array.from(positions);
  const warnings = buildWarnings({
    sawMaterial,
    sawTexCoords,
    sawVertexColors,
    animationCount: doc.animationCount,
    skinCount: doc.skinCount,
    sawMorphTargets,
    skippedUnsupportedPrimitiveCount,
    skippedDegenerateTriangles,
  });

  let primitiveCount = 0;
  for (const meshIndex of visitedMeshIndices) primitiveCount += decoded[meshIndex].primitives.length;

  return {
    positions: positionArray,
    normals: Float32Array.from(normals),
    triangleCount,
    sourceVertexCount: sumSourceVertices(decoded, visitedMeshIndices),
    meshCount: visitedMeshIndices.size,
    primitiveCount,
    nodeInstanceCount,
    sceneName,
    skippedDegenerateTriangles,
    skippedUnsupportedPrimitives: skippedUnsupportedPrimitiveCount,
    bounds: computeBounds(positionArray),
    warnings,
  };
}

function transformAndScale(m: Mat4, positions: Float32Array, vertexIndex: number): [number, number, number] {
  const base = vertexIndex * 3;
  const [x, y, z] = transformPoint(m, [positions[base], positions[base + 1], positions[base + 2]]);
  return [x * METERS_TO_MILLIMETERS, y * METERS_TO_MILLIMETERS, z * METERS_TO_MILLIMETERS];
}

function sumSourceVertices(decoded: DecodedMesh[], visited: ReadonlySet<number>): number {
  let total = 0;
  for (const meshIndex of visited) {
    for (const primitive of decoded[meshIndex].primitives) total += primitive.positions.length / 3;
  }
  return total;
}

function buildWarnings(flags: {
  sawMaterial: boolean;
  sawTexCoords: boolean;
  sawVertexColors: boolean;
  animationCount: number;
  skinCount: number;
  sawMorphTargets: boolean;
  skippedUnsupportedPrimitiveCount: number;
  skippedDegenerateTriangles: number;
}): ConversionWarning[] {
  const warnings: ConversionWarning[] = [];
  const add = (code: ConversionWarning["code"]): void => {
    warnings.push({ code, message: WARNING_COPY[code] });
  };

  if (flags.sawMaterial) add("materials-not-preserved");
  if (flags.sawTexCoords) add("textures-not-preserved");
  if (flags.sawVertexColors) add("vertex-colors-not-preserved");
  if (flags.animationCount > 0) add("animations-not-preserved");
  if (flags.skinCount > 0) add("skins-not-preserved");
  if (flags.sawMorphTargets) add("morph-targets-not-preserved");
  if (flags.skippedUnsupportedPrimitiveCount > 0) add("unsupported-primitives-skipped");
  if (flags.skippedDegenerateTriangles > 0) add("degenerate-triangles-skipped");

  return warnings;
}
