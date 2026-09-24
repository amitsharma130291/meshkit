/**
 * Viewer-specific glTF JSON parsing. Not a second glTF parser: this reads
 * the exact same JSON bytes `parseGLTFSchema()` already validated, but
 * `schema.ts` is deliberately minimal — it never parses `materials`,
 * `textures`, `images`, `samplers`, or an accessor's `normalized` flag,
 * since the converter's geometry path has no use for any of them. Rather
 * than widen the converter's own validated schema (risking its behavior),
 * this module runs its own lightweight validation pass over those specific
 * fields, using native `JSON.parse` — the same zero-risk primitive
 * `parseGLTFSchema` itself uses, not a hand-rolled parser. Everything else
 * a viewer needs (node/mesh/scene names, morph-target counts, additional
 * TEXCOORD sets, extensions) is already captured by `parseGLTFSchema` and
 * is reused directly from its `GLTFDocument`, never re-parsed here.
 */
import { glbError } from "./errors";
import type { GLBAlphaMode, GLBViewerLimits, GLBViewerMaterial, GLBViewerSampler, GLBViewerTexture } from "./viewer-types";
import { sanitizeViewerText } from "./viewer-formatting";

export interface RawGLTFImage {
  mimeType: string | null;
  /** null for a `uri`-based (external) image — never fetched, so it has no bytes. */
  bufferViewIndex: number | null;
}

export interface GLTFViewerResources {
  materials: GLBViewerMaterial[];
  textures: GLBViewerTexture[];
  images: RawGLTFImage[];
  /** Indexed by accessor index — glTF's `normalized` flag, needed to decode `TEXCOORD_0`/`COLOR_0` integer component types correctly. `schema.ts` doesn't track it since the converter never reads UV/color accessors. */
  accessorNormalized: boolean[];
  /** True once for any material whose `baseColorTexture.index` (or any other texture-map index) is out of range against `textures.length`. */
  hasInvalidTextureReference: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArray(value: unknown, maxLength: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw glbError("GLB_JSON_INVALID");
  if (value.length > maxLength) throw glbError("GLB_COMPLEXITY_LIMIT");
  return value;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseVec(value: unknown, length: number, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== length) return fallback;
  return value.map((v, i) => finiteOr(v, fallback[i]));
}

function parseTextureRef(
  value: unknown,
  textureCount: number,
  markInvalid: () => void,
): { textureIndex: number; texCoordSet: number } | null {
  if (!isPlainObject(value)) return null;
  const index = value.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (index >= textureCount) {
    markInvalid();
    return null;
  }
  const texCoordSet = typeof value.texCoord === "number" && Number.isInteger(value.texCoord) && value.texCoord >= 0 ? value.texCoord : 0;
  return { textureIndex: index, texCoordSet };
}

function parseMaterial(value: unknown, textureCount: number, limits: GLBViewerLimits, markInvalid: () => void): GLBViewerMaterial {
  if (!isPlainObject(value)) {
    return {
      name: null,
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: null,
      metallicFactor: 1,
      roughnessFactor: 1,
      emissiveFactor: [0, 0, 0],
      alphaMode: "OPAQUE",
      alphaCutoff: 0.5,
      doubleSided: false,
      unlit: false,
      hasUnsupportedTextureMap: false,
      baseColorTextureDisabled: false,
    };
  }

  const pbr = isPlainObject(value.pbrMetallicRoughness) ? value.pbrMetallicRoughness : {};
  const baseColorFactorRaw = parseVec(pbr.baseColorFactor, 4, [1, 1, 1, 1]);
  const baseColorFactor: [number, number, number, number] = [
    clamp01(baseColorFactorRaw[0]),
    clamp01(baseColorFactorRaw[1]),
    clamp01(baseColorFactorRaw[2]),
    clamp01(baseColorFactorRaw[3]),
  ];

  let baseColorTexture = parseTextureRef(pbr.baseColorTexture, textureCount, markInvalid);
  let baseColorTextureDisabled = false;
  if (baseColorTexture) {
    if (baseColorTexture.texCoordSet !== 0) {
      baseColorTextureDisabled = true;
    }
    const transformExt = isPlainObject(pbr.baseColorTexture) ? pbr.baseColorTexture.extensions : undefined;
    if (isPlainObject(transformExt) && transformExt.KHR_texture_transform !== undefined) {
      baseColorTextureDisabled = true;
    }
  }
  if (baseColorTextureDisabled) baseColorTexture = null;

  const hasUnsupportedTextureMap =
    pbr.metallicRoughnessTexture !== undefined ||
    value.normalTexture !== undefined ||
    value.occlusionTexture !== undefined;

  const extensions = isPlainObject(value.extensions) ? value.extensions : {};
  const unlit = extensions.KHR_materials_unlit !== undefined;

  const alphaModeRaw = value.alphaMode;
  const alphaMode: GLBAlphaMode = alphaModeRaw === "MASK" || alphaModeRaw === "BLEND" ? alphaModeRaw : "OPAQUE";

  return {
    name: typeof value.name === "string" ? sanitizeViewerText(value.name, limits.maxNameLength) : null,
    baseColorFactor,
    baseColorTexture,
    metallicFactor: clamp01(finiteOr(pbr.metallicFactor, 1)),
    roughnessFactor: clamp01(finiteOr(pbr.roughnessFactor, 1)),
    emissiveFactor: parseVec(value.emissiveFactor, 3, [0, 0, 0]) as [number, number, number],
    alphaMode,
    alphaCutoff: clamp01(finiteOr(value.alphaCutoff, 0.5)),
    doubleSided: value.doubleSided === true,
    unlit,
    hasUnsupportedTextureMap,
    baseColorTextureDisabled,
  };
}

const WRAP_REPEAT = 10497;
const KNOWN_WRAP_MODES: ReadonlySet<number> = new Set([10497, 33071, 33648]);
const KNOWN_FILTERS: ReadonlySet<number> = new Set([9728, 9729, 9984, 9985, 9986, 9987]);

function parseSampler(value: unknown): GLBViewerSampler {
  if (!isPlainObject(value)) return { wrapS: WRAP_REPEAT, wrapT: WRAP_REPEAT, magFilter: null, minFilter: null };
  const wrapS = typeof value.wrapS === "number" && KNOWN_WRAP_MODES.has(value.wrapS) ? value.wrapS : WRAP_REPEAT;
  const wrapT = typeof value.wrapT === "number" && KNOWN_WRAP_MODES.has(value.wrapT) ? value.wrapT : WRAP_REPEAT;
  const magFilter = typeof value.magFilter === "number" && KNOWN_FILTERS.has(value.magFilter) ? value.magFilter : null;
  const minFilter = typeof value.minFilter === "number" && KNOWN_FILTERS.has(value.minFilter) ? value.minFilter : null;
  return { wrapS, wrapT, magFilter, minFilter };
}

const DEFAULT_SAMPLER: GLBViewerSampler = { wrapS: WRAP_REPEAT, wrapT: WRAP_REPEAT, magFilter: null, minFilter: null };

function parseTexture(value: unknown, imageCount: number, samplers: GLBViewerSampler[]): GLBViewerTexture {
  if (!isPlainObject(value)) return { sourceImageIndex: null, sampler: DEFAULT_SAMPLER };

  const source = value.source;
  const sourceImageIndex = typeof source === "number" && Number.isInteger(source) && source >= 0 && source < imageCount ? source : null;

  const samplerIdx = value.sampler;
  const sampler =
    typeof samplerIdx === "number" && Number.isInteger(samplerIdx) && samplers[samplerIdx] !== undefined
      ? samplers[samplerIdx]
      : DEFAULT_SAMPLER;

  return { sourceImageIndex, sampler };
}

function parseImage(value: unknown): RawGLTFImage {
  if (!isPlainObject(value)) return { mimeType: null, bufferViewIndex: null };
  const hasUri = typeof value.uri === "string";
  if (hasUri) return { mimeType: null, bufferViewIndex: null }; // external — never fetched, treated as unavailable
  const bufferView = value.bufferView;
  const bufferViewIndex = typeof bufferView === "number" && Number.isInteger(bufferView) && bufferView >= 0 ? bufferView : null;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : null;
  return { mimeType, bufferViewIndex };
}

export function parseGLTFViewerResources(jsonBytes: Uint8Array, limits: GLBViewerLimits): GLTFViewerResources {
  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
    raw = JSON.parse(text);
  } catch {
    throw glbError("GLB_JSON_INVALID");
  }
  if (!isPlainObject(raw)) throw glbError("GLB_JSON_INVALID");

  const rawImages = parseArray(raw.images, limits.maxImages).map(parseImage);
  const rawSamplers = parseArray(raw.samplers, limits.maxTextures);
  const samplers = rawSamplers.map(parseSampler);
  const rawTextures = parseArray(raw.textures, limits.maxTextures);
  const textures = rawTextures.map((t) => parseTexture(t, rawImages.length, samplers));

  let hasInvalidTextureReference = false;
  const rawMaterials = parseArray(raw.materials, limits.maxMaterials);
  const materials = rawMaterials.map((m) =>
    parseMaterial(m, textures.length, limits, () => {
      hasInvalidTextureReference = true;
    }),
  );

  const rawAccessors = Array.isArray(raw.accessors) ? raw.accessors : [];
  const accessorNormalized = rawAccessors.map((a) => isPlainObject(a) && a.normalized === true);

  return { materials, textures, images: rawImages, accessorNormalized, hasInvalidTextureReference };
}
