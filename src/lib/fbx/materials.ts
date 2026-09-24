/**
 * Extracts a practical, first-viewer subset of an FBX `Material` object's
 * own declared appearance — Lambert/Phong diffuse color and factor, and
 * opacity where it's deterministically available. Every other material
 * model (StingrayPBS, 3dsMax Physical Material, arbitrary shader graphs)
 * still gets *something* sensible: an unrecognized `ShadingModel` falls
 * back to the same Lambert-shaped property reads (`DiffuseColor`/
 * `DiffuseFactor` are present on most exported materials regardless of
 * shading model), never a hard failure.
 */
import { readProperties70 } from "./document";
import type { FBXNode, FBXProperty } from "./types";

/** Rendering itself is always double-sided at the `_client.ts` level, matching this project's existing PLY/GLB "friendlier default preview" policy — FBX's base Lambert/Phong material model has no per-material single/double-sided flag of its own to read (that's a Model-level `Culling` property this phase doesn't otherwise use), so there's nothing meaningful to extract here. */
export interface FBXMaterial {
  name: string;
  shadingModel: string;
  diffuseColor: [number, number, number];
  diffuseFactor: number;
  opacity: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

function readColorTriplet(props: Map<string, FBXProperty[]>, name: string, fallback: [number, number, number]): [number, number, number] {
  const values = props.get(name);
  if (!values || values.length < 3) return fallback;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = values[i];
    if (!v || (v.type !== "D" && v.type !== "F")) return fallback;
    out.push(clamp01(v.value));
  }
  return out as [number, number, number];
}

function readNumber(props: Map<string, FBXProperty[]>, name: string): number | null {
  const v = props.get(name)?.[0];
  if (!v || (v.type !== "D" && v.type !== "F")) return null;
  return v.value;
}

export function decodeFBXMaterial(name: string, node: FBXNode): FBXMaterial {
  const shadingModelNode = node.children.find((c) => c.name === "ShadingModel");
  const shadingProp = shadingModelNode?.properties[0];
  const shadingModel = shadingProp && shadingProp.type === "S" ? shadingProp.value : "unknown";

  const props = readProperties70(node);
  const diffuseColor = readColorTriplet(props, "DiffuseColor", [0.8, 0.8, 0.8]);
  const diffuseFactorRaw = readNumber(props, "DiffuseFactor");
  const diffuseFactor = diffuseFactorRaw === null ? 1 : clamp01(diffuseFactorRaw);

  let opacity = 1;
  const explicitOpacity = readNumber(props, "Opacity");
  if (explicitOpacity !== null) {
    opacity = clamp01(explicitOpacity);
  } else {
    const transparencyFactor = readNumber(props, "TransparencyFactor");
    if (transparencyFactor !== null) opacity = clamp01(1 - transparencyFactor);
  }

  return { name, shadingModel, diffuseColor, diffuseFactor, opacity };
}
