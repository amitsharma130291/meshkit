import { parseGLBContainer } from "./container";
import { parseGLTFSchema } from "./schema";
import { decodeMeshes } from "./primitives";
import { resolveGLBScene } from "./resolve-scene";
import { glbError } from "./errors";
import { DEFAULT_GLB_LIMITS, type GLBLimits, type GLTFDocument, type ResolvedGLBScene } from "./types";

const KNOWN_COMPRESSION_EXTENSIONS: Record<string, "GLB_DRACO_UNSUPPORTED" | "GLB_MESHOPT_UNSUPPORTED"> = {
  KHR_draco_mesh_compression: "GLB_DRACO_UNSUPPORTED",
  EXT_meshopt_compression: "GLB_MESHOPT_UNSUPPORTED",
};

/**
 * Fails fast on a `extensionsRequired` entry this converter can't honor —
 * checked immediately after schema parsing, before any accessor is
 * touched, so an unsupported-but-required extension never produces
 * partial/incomplete output.
 */
export function checkRequiredExtensions(doc: GLTFDocument): void {
  for (const name of doc.extensionsRequired) {
    const compressionCode = KNOWN_COMPRESSION_EXTENSIONS[name];
    if (compressionCode) throw glbError(compressionCode);
    throw glbError("GLB_EXTENSION_REQUIRED_UNSUPPORTED");
  }
}

export interface GLBDecodeSteps {
  doc: GLTFDocument;
  bin: Uint8Array | null;
}

/** Container + schema parsing only — split out so the worker can report progress between it and geometry decoding. */
export function parseGLB(buffer: ArrayBuffer, limits: GLBLimits): GLBDecodeSteps {
  const { json, bin } = parseGLBContainer(buffer, limits);
  const doc = parseGLTFSchema(json, limits);
  checkRequiredExtensions(doc);
  return { doc, bin };
}

/** Full pipeline in one call — used by tests and anywhere outside the worker's staged progress reporting. */
export function convertGLBBuffer(buffer: ArrayBuffer, limits: GLBLimits = DEFAULT_GLB_LIMITS): ResolvedGLBScene {
  const { doc, bin } = parseGLB(buffer, limits);
  const { meshes, skippedUnsupportedPrimitiveCount } = decodeMeshes(doc, bin, limits);
  return resolveGLBScene(doc, meshes, limits, skippedUnsupportedPrimitiveCount);
}
