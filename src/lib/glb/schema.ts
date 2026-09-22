/**
 * Validates the GLB JSON chunk into a typed, safety-checked `GLTFDocument`.
 * Uses the native `JSON.parse` (not a hand-rolled parser — unlike 3MF's
 * XML, JSON has no XXE-equivalent risk and V8's parser is already a
 * well-tested, safe dependency) but never trusts the *shape* of what comes
 * back: every array this converter reads is length-capped against
 * `GLBLimits` before anything is allocated from it, and every field this
 * converter actually uses is type/range-checked here so later modules
 * (accessors.ts, primitives.ts, resolve-scene.ts) can trust their inputs.
 */
import { glbError, type GLBErrorCode } from "./errors";
import type {
  GLBLimits,
  GLTFAccessor,
  GLTFBuffer,
  GLTFBufferView,
  GLTFDocument,
  GLTFMesh,
  GLTFNode,
  GLTFPrimitive,
  GLTFScene,
  GLTFSparse,
} from "./types";

const MAX_JSON_TEXT_LENGTH_CHARS = 64 * 1024 * 1024; // characters, post-decode — a coarse pre-parse guard

export function parseGLTFSchema(jsonBytes: Uint8Array, limits: GLBLimits): GLTFDocument {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    throw glbError("GLB_JSON_INVALID");
  }
  if (text.length > MAX_JSON_TEXT_LENGTH_CHARS) {
    throw glbError("GLB_FILE_TOO_LARGE");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw glbError("GLB_JSON_INVALID");
  }
  if (!isPlainObject(raw)) {
    throw glbError("GLB_JSON_INVALID");
  }

  const asset = parseAsset(raw.asset);

  const scenes = parseArray(raw.scenes, limits.maxScenes, "GLB_JSON_INVALID").map(parseScene);
  const nodes = parseArray(raw.nodes, limits.maxNodes, "GLB_JSON_INVALID").map(parseNode);
  const meshes = parseArray(raw.meshes, limits.maxMeshes, "GLB_JSON_INVALID").map((m) => parseMesh(m, limits));
  const accessors = parseArray(raw.accessors, limits.maxAccessors, "GLB_JSON_INVALID").map((a) =>
    parseAccessor(a, limits),
  );
  const bufferViews = parseArray(raw.bufferViews, limits.maxBufferViews, "GLB_JSON_INVALID").map(parseBufferView);
  const buffers = parseArray(raw.buffers, limits.maxBuffers, "GLB_JSON_INVALID").map(parseBuffer);

  const scene = raw.scene !== undefined ? requireNonNegativeInt(raw.scene, "GLB_JSON_INVALID") : undefined;
  const extensionsRequired = parseStringArray(raw.extensionsRequired);
  const extensionsUsed = parseStringArray(raw.extensionsUsed);

  const materialsUsed = meshes.some((mesh) => mesh.primitives.some((p) => p.material !== undefined));
  const animationCount = isPlainObject(raw) && Array.isArray(raw.animations) ? raw.animations.length : 0;
  const skinCount = isPlainObject(raw) && Array.isArray(raw.skins) ? raw.skins.length : 0;

  return {
    asset,
    scene,
    scenes,
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers,
    extensionsRequired,
    extensionsUsed,
    materialsUsed,
    animationCount,
    skinCount,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArray<T>(value: unknown, maxLength: number, code: GLBErrorCode): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw glbError(code);
  if (value.length > maxLength) throw glbError("GLB_COMPLEXITY_LIMIT");
  return value as T[];
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw glbError("GLB_JSON_INVALID");
  if (!value.every((v) => typeof v === "string")) throw glbError("GLB_JSON_INVALID");
  return value as string[];
}

function requireNonNegativeInt(value: unknown, code: GLBErrorCode): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw glbError(code);
  return value;
}

function optionalNonNegativeInt(value: unknown, fallback: number, code: GLBErrorCode): number {
  if (value === undefined) return fallback;
  return requireNonNegativeInt(value, code);
}

function parseAsset(value: unknown): { version: string } {
  if (!isPlainObject(value) || typeof value.version !== "string") {
    throw glbError("GLB_ASSET_INVALID");
  }
  // Accept any 2.x — reject 1.x and anything else rather than guess compatibility.
  if (!/^2\.\d+$/.test(value.version)) {
    throw glbError("GLB_ASSET_INVALID");
  }
  return { version: value.version };
}

function parseScene(value: unknown): GLTFScene {
  if (!isPlainObject(value)) throw glbError("GLB_JSON_INVALID");
  const nodes = value.nodes === undefined ? [] : value.nodes;
  if (!Array.isArray(nodes) || !nodes.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    throw glbError("GLB_NODE_INVALID");
  }
  if (new Set(nodes).size !== nodes.length) {
    throw glbError("GLB_NODE_INVALID"); // duplicate root node reference — ambiguous
  }
  return { nodes: nodes as number[], name: typeof value.name === "string" ? value.name : undefined };
}

function parseNode(value: unknown): GLTFNode {
  if (!isPlainObject(value)) throw glbError("GLB_NODE_INVALID");

  const children = value.children === undefined ? [] : value.children;
  if (!Array.isArray(children) || !children.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0)) {
    throw glbError("GLB_NODE_INVALID");
  }

  const hasMatrix = value.matrix !== undefined;
  const hasTRS = value.translation !== undefined || value.rotation !== undefined || value.scale !== undefined;
  if (hasMatrix && hasTRS) {
    throw glbError("GLB_NODE_INVALID"); // a node may not define both — see transforms.ts's TRS-vs-matrix handling
  }

  const matrix = hasMatrix ? requireNumberArray(value.matrix, 16, "GLB_TRANSFORM_INVALID") : undefined;
  const translation = value.translation !== undefined ? requireNumberArray(value.translation, 3, "GLB_TRANSFORM_INVALID") : undefined;
  const rotation = value.rotation !== undefined ? requireNumberArray(value.rotation, 4, "GLB_TRANSFORM_INVALID") : undefined;
  const scale = value.scale !== undefined ? requireNumberArray(value.scale, 3, "GLB_TRANSFORM_INVALID") : undefined;

  return {
    children: children as number[],
    mesh: value.mesh !== undefined ? requireNonNegativeInt(value.mesh, "GLB_NODE_INVALID") : undefined,
    skin: value.skin !== undefined ? requireNonNegativeInt(value.skin, "GLB_NODE_INVALID") : undefined,
    matrix,
    translation,
    rotation,
    scale,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

function requireNumberArray(value: unknown, length: number, code: "GLB_TRANSFORM_INVALID"): number[] {
  if (!Array.isArray(value) || value.length !== length) throw glbError(code);
  return value.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw glbError(code);
    return v;
  });
}

function parseMesh(value: unknown, limits: GLBLimits): GLTFMesh {
  if (!isPlainObject(value)) throw glbError("GLB_JSON_INVALID");
  const primitives = parseArray<unknown>(value.primitives, limits.maxPrimitivesPerMesh, "GLB_JSON_INVALID").map(
    parsePrimitive,
  );
  return { primitives, name: typeof value.name === "string" ? value.name : undefined };
}

function parsePrimitive(value: unknown): GLTFPrimitive {
  if (!isPlainObject(value) || !isPlainObject(value.attributes)) {
    throw glbError("GLB_JSON_INVALID");
  }
  const attributes: Record<string, number | undefined> = {};
  for (const [key, v] of Object.entries(value.attributes)) {
    attributes[key] = requireNonNegativeInt(v, "GLB_JSON_INVALID");
  }
  return {
    attributes,
    indices: value.indices !== undefined ? requireNonNegativeInt(value.indices, "GLB_JSON_INVALID") : undefined,
    material: value.material !== undefined ? requireNonNegativeInt(value.material, "GLB_JSON_INVALID") : undefined,
    mode: optionalNonNegativeInt(value.mode, 4, "GLB_JSON_INVALID"),
    targets: Array.isArray(value.targets) && value.targets.length > 0 ? (value.targets as Record<string, number>[]) : undefined,
    extensions: isPlainObject(value.extensions) ? value.extensions : undefined,
  };
}

function parseAccessor(value: unknown, limits: GLBLimits): GLTFAccessor {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw glbError("GLB_ACCESSOR_INVALID");
  }
  const count = requireNonNegativeInt(value.count, "GLB_ACCESSOR_INVALID");
  if (count > limits.maxAccessorElements) throw glbError("GLB_COMPLEXITY_LIMIT");

  return {
    bufferView: value.bufferView !== undefined ? requireNonNegativeInt(value.bufferView, "GLB_ACCESSOR_INVALID") : undefined,
    byteOffset: optionalNonNegativeInt(value.byteOffset, 0, "GLB_ACCESSOR_INVALID"),
    componentType: requireNonNegativeInt(value.componentType, "GLB_ACCESSOR_INVALID"),
    count,
    type: value.type,
    sparse: value.sparse !== undefined ? parseSparse(value.sparse, limits) : undefined,
  };
}

function parseSparse(value: unknown, limits: GLBLimits): GLTFSparse {
  if (!isPlainObject(value) || !isPlainObject(value.indices) || !isPlainObject(value.values)) {
    throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
  }
  const count = requireNonNegativeInt(value.count, "GLB_SPARSE_ACCESSOR_INVALID");
  if (count > limits.maxAccessorElements) throw glbError("GLB_COMPLEXITY_LIMIT");

  return {
    count,
    indices: {
      bufferView: requireNonNegativeInt(value.indices.bufferView, "GLB_SPARSE_ACCESSOR_INVALID"),
      byteOffset: optionalNonNegativeInt(value.indices.byteOffset, 0, "GLB_SPARSE_ACCESSOR_INVALID"),
      componentType: requireNonNegativeInt(value.indices.componentType, "GLB_SPARSE_ACCESSOR_INVALID"),
    },
    values: {
      bufferView: requireNonNegativeInt(value.values.bufferView, "GLB_SPARSE_ACCESSOR_INVALID"),
      byteOffset: optionalNonNegativeInt(value.values.byteOffset, 0, "GLB_SPARSE_ACCESSOR_INVALID"),
    },
  };
}

function parseBufferView(value: unknown): GLTFBufferView {
  if (!isPlainObject(value)) throw glbError("GLB_BUFFER_VIEW_INVALID");
  const byteStride = value.byteStride !== undefined ? requireNonNegativeInt(value.byteStride, "GLB_BUFFER_VIEW_INVALID") : undefined;
  return {
    buffer: requireNonNegativeInt(value.buffer, "GLB_BUFFER_VIEW_INVALID"),
    byteOffset: optionalNonNegativeInt(value.byteOffset, 0, "GLB_BUFFER_VIEW_INVALID"),
    byteLength: requireNonNegativeInt(value.byteLength, "GLB_BUFFER_VIEW_INVALID"),
    byteStride,
    extensions: isPlainObject(value.extensions) ? value.extensions : undefined,
  };
}

function parseBuffer(value: unknown): GLTFBuffer {
  if (!isPlainObject(value)) throw glbError("GLB_BUFFER_INVALID");
  return {
    byteLength: requireNonNegativeInt(value.byteLength, "GLB_BUFFER_INVALID"),
    uri: typeof value.uri === "string" ? value.uri : undefined,
  };
}
