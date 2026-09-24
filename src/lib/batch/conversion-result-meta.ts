/**
 * The explicit, per-format report-metadata contract for the six batch
 * conversion operations — the Phase 10 hotfix for a confirmed defect
 * where `unwrapConversionResult()` used to spread a worker's ENTIRE raw
 * result (including the full `positions`/`normals` source-geometry
 * arrays it also returns for the single-file 3D-viewport preview)
 * verbatim into `resultMeta`, which then flowed unbounded into the
 * downloadable JSON report and ZIP `batch-summary.json`.
 *
 * Each `project*Meta()` function below explicitly PICKS only the small,
 * JSON-safe, genuinely useful summary fields a real worker result
 * contains — never a spread, never a recursive "strip the bad stuff"
 * sanitizer. A field not explicitly named here can never reach a batch
 * report, no matter what a worker's result object happens to contain.
 *
 * `CONVERSION_RESULT_META_ALLOWED_KEYS` restates each projector's own
 * output keys as a `Set`, used by `result-meta-guard.ts`'s defense-in-
 * depth check (Stage 4) as a second, independent layer — so even a
 * mistake inside one of these projector functions (e.g. a future
 * edit that accidentally starts returning a typed array again) is still
 * caught before it reaches a downloadable file.
 *
 * A single conversion's projected metadata is always small: at most a
 * few dozen bounded scalar fields, one small fixed-shape bounds object
 * (12 numbers), and a warnings array bounded by the small number of
 * distinct warning categories each format defines (never one entry per
 * vertex/triangle) — see `MAX_CONVERSION_RESULT_META_BYTES` below for
 * the documented ceiling `result-meta-guard.ts` enforces regardless.
 */
import type { BatchOperationId } from "./types";

export interface BoundsSummary {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export interface ConversionWarningSummary {
  code: string;
  message: string;
}

/**
 * The union of every safe field any of the six conversion formats'
 * projectors can produce. All fields are optional here because no
 * single format populates all of them — each `project*Meta()` function
 * below returns only the subset that format's real result actually has.
 */
export interface ConversionResultMeta {
  triangleCount?: number;
  sourceVertexCount?: number;
  sourceFaceCount?: number;
  objectCount?: number;
  groupCount?: number;
  materialLibraryCount?: number;
  usedMaterialCount?: number;
  ignoredLineCount?: number;
  ignoredPointCount?: number;
  buildItemCount?: number;
  componentInstanceCount?: number;
  sourceUnit?: string;
  meshCount?: number;
  primitiveCount?: number;
  nodeInstanceCount?: number;
  sceneName?: string;
  skippedDegenerateTriangles?: number;
  skippedUnsupportedPrimitives?: number;
  sourceUnits?: string;
  outputScale?: string;
  scaleFactor?: number;
  vertexPropertyCount?: number;
  facePropertyCount?: number;
  unknownElementCount?: number;
  unknownPropertyCount?: number;
  format?: string;
  inputEncoding?: string;
  inputTriangleCount?: number;
  outputFaceCount?: number;
  outputTriangleCount?: number;
  sourceTriangleVertexCount?: number;
  uniqueVertexCount?: number;
  duplicateVertexReferencesRemoved?: number;
  declaredUnit?: string;
  coordinateScale?: number;
  outputByteLength?: number;
  bounds?: BoundsSummary;
  warnings?: ConversionWarningSummary[];
}

function projectBounds(raw: Record<string, unknown>): BoundsSummary | undefined {
  const bounds = raw.bounds;
  if (typeof bounds !== "object" || bounds === null) return undefined;
  const b = bounds as Record<string, unknown>;
  if (!Array.isArray(b.min) || !Array.isArray(b.max) || !Array.isArray(b.size) || !Array.isArray(b.center)) return undefined;
  return {
    min: [Number(b.min[0]), Number(b.min[1]), Number(b.min[2])],
    max: [Number(b.max[0]), Number(b.max[1]), Number(b.max[2])],
    size: [Number(b.size[0]), Number(b.size[1]), Number(b.size[2])],
    center: [Number(b.center[0]), Number(b.center[1]), Number(b.center[2])],
  };
}

function projectWarnings(raw: Record<string, unknown>): ConversionWarningSummary[] | undefined {
  const warnings = raw.warnings;
  if (!Array.isArray(warnings)) return undefined;
  return warnings.map((w) => ({ code: String((w as Record<string, unknown>)?.code ?? ""), message: String((w as Record<string, unknown>)?.message ?? "") }));
}

export function projectObjToStlMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  return {
    triangleCount: r.triangleCount as number,
    sourceVertexCount: r.sourceVertexCount as number,
    sourceFaceCount: r.sourceFaceCount as number,
    objectCount: r.objectCount as number,
    groupCount: r.groupCount as number,
    materialLibraryCount: r.materialLibraryCount as number,
    usedMaterialCount: r.usedMaterialCount as number,
    ignoredLineCount: r.ignoredLineCount as number,
    ignoredPointCount: r.ignoredPointCount as number,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
}

export function projectThreeMFToStlMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  return {
    triangleCount: r.triangleCount as number,
    objectCount: r.objectCount as number,
    buildItemCount: r.buildItemCount as number,
    componentInstanceCount: r.componentInstanceCount as number,
    sourceUnit: r.sourceUnit as string,
    outputScale: r.outputScale as string,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
}

export function projectGlbToStlMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  const meta: ConversionResultMeta = {
    triangleCount: r.triangleCount as number,
    sourceVertexCount: r.sourceVertexCount as number,
    meshCount: r.meshCount as number,
    primitiveCount: r.primitiveCount as number,
    nodeInstanceCount: r.nodeInstanceCount as number,
    skippedDegenerateTriangles: r.skippedDegenerateTriangles as number,
    skippedUnsupportedPrimitives: r.skippedUnsupportedPrimitives as number,
    sourceUnits: r.sourceUnits as string,
    outputScale: r.outputScale as string,
    scaleFactor: r.scaleFactor as number,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
  // `sceneName` is genuinely optional at the source (glTF scenes aren't required to have one) — never fabricate an empty string when it's absent.
  if (typeof r.sceneName === "string") meta.sceneName = r.sceneName;
  return meta;
}

export function projectPlyToStlMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  return {
    triangleCount: r.triangleCount as number,
    sourceVertexCount: r.sourceVertexCount as number,
    sourceFaceCount: r.sourceFaceCount as number,
    vertexPropertyCount: r.vertexPropertyCount as number,
    facePropertyCount: r.facePropertyCount as number,
    unknownElementCount: r.unknownElementCount as number,
    unknownPropertyCount: r.unknownPropertyCount as number,
    format: r.format as string,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
}

export function projectStlToObjMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  return {
    inputEncoding: r.inputEncoding as string,
    inputTriangleCount: r.inputTriangleCount as number,
    outputFaceCount: r.outputFaceCount as number,
    sourceTriangleVertexCount: r.sourceTriangleVertexCount as number,
    uniqueVertexCount: r.uniqueVertexCount as number,
    duplicateVertexReferencesRemoved: r.duplicateVertexReferencesRemoved as number,
    skippedDegenerateTriangles: r.skippedDegenerateTriangles as number,
    outputByteLength: r.outputByteLength as number,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
}

export function projectStlToThreeMFMeta(raw: unknown): ConversionResultMeta {
  const r = raw as Record<string, unknown>;
  return {
    inputEncoding: r.inputEncoding as string,
    inputTriangleCount: r.inputTriangleCount as number,
    outputTriangleCount: r.outputTriangleCount as number,
    sourceTriangleVertexCount: r.sourceTriangleVertexCount as number,
    uniqueVertexCount: r.uniqueVertexCount as number,
    duplicateVertexReferencesRemoved: r.duplicateVertexReferencesRemoved as number,
    skippedDegenerateTriangles: r.skippedDegenerateTriangles as number,
    declaredUnit: r.declaredUnit as string,
    coordinateScale: r.coordinateScale as number,
    outputByteLength: r.outputByteLength as number,
    bounds: projectBounds(r),
    warnings: projectWarnings(r),
  };
}

export type ConversionOperationId = "convert-3mf-to-stl" | "convert-obj-to-stl" | "convert-glb-to-stl" | "convert-ply-to-stl" | "convert-stl-to-obj" | "convert-stl-to-3mf";

export const CONVERSION_RESULT_META_PROJECTORS: Record<ConversionOperationId, (raw: unknown) => ConversionResultMeta> = {
  "convert-3mf-to-stl": projectThreeMFToStlMeta,
  "convert-obj-to-stl": projectObjToStlMeta,
  "convert-glb-to-stl": projectGlbToStlMeta,
  "convert-ply-to-stl": projectPlyToStlMeta,
  "convert-stl-to-obj": projectStlToObjMeta,
  "convert-stl-to-3mf": projectStlToThreeMFMeta,
};

const COMMON_KEYS = ["bounds", "warnings"] as const;

/** Restates each projector's own possible output keys as a `Set`, for `result-meta-guard.ts`'s independent second-layer check. */
export const CONVERSION_RESULT_META_ALLOWED_KEYS: Record<ConversionOperationId, ReadonlySet<string>> = {
  "convert-3mf-to-stl": new Set([...COMMON_KEYS, "triangleCount", "objectCount", "buildItemCount", "componentInstanceCount", "sourceUnit", "outputScale"]),
  "convert-obj-to-stl": new Set([...COMMON_KEYS, "triangleCount", "sourceVertexCount", "sourceFaceCount", "objectCount", "groupCount", "materialLibraryCount", "usedMaterialCount", "ignoredLineCount", "ignoredPointCount"]),
  "convert-glb-to-stl": new Set([...COMMON_KEYS, "triangleCount", "sourceVertexCount", "meshCount", "primitiveCount", "nodeInstanceCount", "sceneName", "skippedDegenerateTriangles", "skippedUnsupportedPrimitives", "sourceUnits", "outputScale", "scaleFactor"]),
  "convert-ply-to-stl": new Set([...COMMON_KEYS, "triangleCount", "sourceVertexCount", "sourceFaceCount", "vertexPropertyCount", "facePropertyCount", "unknownElementCount", "unknownPropertyCount", "format"]),
  "convert-stl-to-obj": new Set([...COMMON_KEYS, "inputEncoding", "inputTriangleCount", "outputFaceCount", "sourceTriangleVertexCount", "uniqueVertexCount", "duplicateVertexReferencesRemoved", "skippedDegenerateTriangles", "outputByteLength"]),
  "convert-stl-to-3mf": new Set([...COMMON_KEYS, "inputEncoding", "inputTriangleCount", "outputTriangleCount", "sourceTriangleVertexCount", "uniqueVertexCount", "duplicateVertexReferencesRemoved", "skippedDegenerateTriangles", "declaredUnit", "coordinateScale", "outputByteLength"]),
};

export function isConversionOperationId(id: BatchOperationId): id is ConversionOperationId {
  return id in CONVERSION_RESULT_META_PROJECTORS;
}

/**
 * The documented maximum reasonable size for one file's projected
 * conversion metadata: every field above is either a single bounded
 * scalar, a fixed 12-number bounds object, or a warnings array bounded
 * by the small number of distinct warning categories a format defines
 * (never one entry per vertex/triangle/face) — even a maximally verbose
 * real result comfortably serializes under 2KB. `result-meta-guard.ts`
 * enforces a much larger ceiling (see `MAX_RESULT_META_SERIALIZED_BYTES`)
 * purely as defense-in-depth against a future regression, not because
 * legitimate conversion metadata is expected to approach it.
 */
export const MAX_CONVERSION_RESULT_META_BYTES = 2048;
