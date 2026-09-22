import { threeMFError } from "./errors";
import { parseThreeMFModel } from "./model-parser";
import { openThreeMFPackage } from "./package";
import { findPrimaryModelPath } from "./relationships";
import { resolveScene } from "./resolve-scene";
import type { ResolvedScene, ThreeMFLimits, ThreeMFUnit } from "./types";

export interface ThreeMFConversionResult extends ResolvedScene {
  sourceUnit: ThreeMFUnit;
}

/**
 * Full pipeline: open the ZIP package (with every safety check enforced
 * during central-directory parsing), locate the primary model part via
 * OPC relationships, parse its XML, then resolve the build scene into
 * flattened, millimeter-scale geometry. This is the only export other
 * code (the worker, tests) should call.
 */
export function convertThreeMFPackage(buffer: ArrayBuffer, limits: ThreeMFLimits): ThreeMFConversionResult {
  const pkg = openThreeMFPackage(buffer, limits);
  const modelPath = findPrimaryModelPath(pkg);
  const modelBytes = pkg.readEntry(modelPath);

  if (modelBytes.byteLength > limits.maxModelXmlBytes) {
    throw threeMFError("THREEMF_COMPLEXITY_LIMIT");
  }

  const xml = new TextDecoder("utf-8", { fatal: false }).decode(modelBytes);
  const model = parseThreeMFModel(xml, limits);
  const scene = resolveScene(model, limits);

  return { ...scene, sourceUnit: model.unit };
}
