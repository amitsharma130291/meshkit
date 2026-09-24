/**
 * FBX adapter — wraps `fbx-viewer.worker.ts` unchanged. Mirrors
 * `src/pages/fbx-viewer/_client.ts`: per-corner, non-indexed geometry
 * with an identity `indices` buffer rebuilt per visible segment,
 * per-material Three.js materials built 1:1 from `result.materials`
 * (already deduplicated by `resolve-scene.ts`) plus one shared fallback,
 * and embedded PNG/JPEG textures decoded on the main thread. Axis and
 * unit normalization already happened inside the worker's own
 * `resolve-scene.ts` — this adapter never re-applies or second-guesses it.
 */
import { formatMagnitude, formatTriangleCount } from "../../stl/format";
import type { STLBounds } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { FBXViewerResult as FBXAdapterResult } from "../../fbx/viewer-types";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

export type { FBXAdapterResult };

type ThreeModule = typeof import("three");

function segmentKey(index: number): string {
  return `fbx:seg:${index}`;
}

let mesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let geometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let originalMaterials: InstanceType<ThreeModule["Material"]>[] = [];
let decodedTextures: (InstanceType<ThreeModule["Texture"]> | null)[] = [];
let decodedBitmaps: (ImageBitmap | null)[] = [];
let singleMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let lastResult: FBXAdapterResult | null = null;

function disposeAll(): void {
  geometry?.dispose();
  for (const m of originalMaterials) m.dispose();
  originalMaterials = [];
  mesh = null;
  geometry = null;
  singleMaterial?.dispose();
  singleMaterial = null;
  for (const t of decodedTextures) t?.dispose();
  decodedTextures = [];
  for (const b of decodedBitmaps) b?.close();
  decodedBitmaps = [];
}

async function decodeImages(result: FBXAdapterResult): Promise<void> {
  decodedBitmaps = [];
  for (const image of result.images) {
    if (!image || typeof createImageBitmap !== "function") {
      decodedBitmaps.push(null);
      continue;
    }
    try {
      const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
      decodedBitmaps.push(await createImageBitmap(blob));
    } catch {
      decodedBitmaps.push(null);
    }
  }
}

function buildMaterials(ctx: AdapterContext, result: FBXAdapterResult, options: AdapterDisplayOptions): void {
  const { THREE } = ctx;
  originalMaterials = result.materials.map((m) => {
    let map: InstanceType<ThreeModule["Texture"]> | null = null;
    if (m.embeddedImageIndex !== null) {
      const bitmap = decodedBitmaps[m.embeddedImageIndex];
      if (bitmap) {
        const tex = new THREE.Texture(bitmap);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        decodedTextures.push(tex);
        map = tex;
      }
    }
    const [r, g, b] = m.diffuseColor;
    const f = m.diffuseFactor;
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(r * f, g * f, b * f), map, transparent: m.opacity < 1, opacity: m.opacity, side: THREE.DoubleSide, metalness: 0.05, roughness: 0.7, wireframe: options.wireframe });
  });
  originalMaterials.push(new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: options.wireframe }));
}

function rebuildIndex(ctx: AdapterContext, result: FBXAdapterResult, hidden: ReadonlySet<string>): void {
  if (!geometry) return;
  const fallbackIdx = originalMaterials.length - 1;
  let total = 0;
  result.segments.forEach((seg, i) => {
    if (!hidden.has(segmentKey(i))) total += seg.indexCount;
  });
  const newIndex = new Uint32Array(total);
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  let offset = 0;
  result.segments.forEach((seg, i) => {
    if (hidden.has(segmentKey(i))) return;
    for (let k = 0; k < seg.indexCount; k++) newIndex[offset + k] = result.indices[seg.indexStart + k];
    groups.push({ start: offset, count: seg.indexCount, materialIndex: seg.materialIndex ?? fallbackIdx });
    offset += seg.indexCount;
  });
  geometry.setIndex(new ctx.THREE.BufferAttribute(newIndex, 1));
  geometry.clearGroups();
  for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);
}

const adapter: ViewerAdapter<FBXAdapterResult> = {
  format: "fbx",
  label: "FBX",
  extensions: ["fbx"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/fbx-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(result: FBXAdapterResult): AdapterCapabilities {
    return {
      wireframe: true,
      shading: result.hasSourceNormals,
      colorModes: result.hasVertexColors ? ["original", "neutral", "vertex-colors"] : ["original", "neutral"],
      segments: true,
      materials: result.materials.length > 0,
      unitNote: result.normalizedToMeters ? "m (normalized)" : "model units (unnormalized)",
    };
  },

  async buildScene(ctx: AdapterContext, result: FBXAdapterResult, options: AdapterDisplayOptions): Promise<void> {
    if (mesh) ctx.scene.remove(mesh);
    disposeAll();
    lastResult = result;
    const { THREE } = ctx;

    await decodeImages(result);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    if (result.uvs) geo.setAttribute("uv", new THREE.BufferAttribute(result.uvs, 2));
    if (result.colors) geo.setAttribute("color", new THREE.BufferAttribute(result.colors, 4));

    buildMaterials(ctx, result, options);
    const m = new THREE.Mesh(geo, originalMaterials);
    ctx.scene.add(m);
    mesh = m;
    geometry = geo;
    rebuildIndex(ctx, result, options.hiddenSegmentKeys);
    applyColorMode(ctx, result, options);
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    if (!lastResult || !geometry) return;
    rebuildIndex(ctx, lastResult, options.hiddenSegmentKeys);
    applyColorMode(ctx, lastResult, options);
    for (const m of originalMaterials) {
      if ("wireframe" in m) (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).wireframe = options.wireframe;
    }
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (mesh) ctx.scene.remove(mesh);
    disposeAll();
    lastResult = null;
  },

  fitAllTarget(result: FBXAdapterResult): AdapterFitTarget {
    const [sx, sy, sz] = result.boundsModelUnits.size;
    return { radius: Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6), center: result.boundsModelUnits.center };
  },

  fitVisibleTarget(result: FBXAdapterResult, hidden: ReadonlySet<string>): AdapterFitTarget | null {
    const list: STLBounds[] = [];
    result.segments.forEach((seg, i) => {
      if (!hidden.has(segmentKey(i))) list.push(seg.bounds);
    });
    if (list.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of list) {
      if (b.min[0] < minX) minX = b.min[0];
      if (b.min[1] < minY) minY = b.min[1];
      if (b.min[2] < minZ) minZ = b.min[2];
      if (b.max[0] > maxX) maxX = b.max[0];
      if (b.max[1] > maxY) maxY = b.max[1];
      if (b.max[2] > maxZ) maxZ = b.max[2];
    }
    const size: [number, number, number] = [maxX - minX, maxY - minY, maxZ - minZ];
    const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    return { radius: Math.max(Math.sqrt((size[0] / 2) ** 2 + (size[1] / 2) ** 2 + (size[2] / 2) ** 2), 1e-6), center };
  },

  info(result: FBXAdapterResult): UniversalInfoField[] {
    return [
      { label: "FBX version", value: String(result.fbxVersion) },
      { label: "Encoding", value: `Binary (${result.recordLayout})` },
      { label: "Models", value: formatTriangleCount(result.modelCount) },
      { label: "Geometries", value: formatTriangleCount(result.geometryCount) },
      { label: "Mesh instances", value: formatTriangleCount(result.meshInstanceCount) },
      { label: "Triangles", value: formatTriangleCount(result.renderedTriangleCount) },
      { label: "Materials", value: formatTriangleCount(result.materials.length) },
      { label: "Axis system", value: result.axisSystemKnown ? "Declared — normalized" : "Not declared" },
    ];
  },

  dimensions(result: FBXAdapterResult) {
    const unit = result.normalizedToMeters ? "m" : "model units";
    return {
      width: `${formatMagnitude(result.boundsModelUnits.size[0])} ${unit}`,
      height: `${formatMagnitude(result.boundsModelUnits.size[1])} ${unit}`,
      depth: `${formatMagnitude(result.boundsModelUnits.size[2])} ${unit}`,
    };
  },

  unsupportedFeaturesNote(result: FBXAdapterResult): string | null {
    return result.unsupportedFeatures.length > 0 ? `Detected but not applied: ${result.unsupportedFeatures.join(", ")}.` : null;
  },

  warnings(result: FBXAdapterResult) {
    return result.warnings;
  },

  segments(result: FBXAdapterResult): AdapterSegmentRow[] | null {
    if (result.segments.length === 0) return null;
    return result.segments.map((seg, i) => ({
      key: segmentKey(i),
      groupLabel: seg.modelName ?? `Model ${i}`,
      rowLabel: "Mesh instance",
      countLabel: formatTriangleCount(seg.indexCount / 3),
      visible: true,
    }));
  },

  materials(result: FBXAdapterResult): AdapterMaterialCard[] | null {
    if (result.materials.length === 0) return null;
    return result.materials.map((m) => ({
      name: m.name ?? "(unnamed material)",
      colorHex: `#${Math.round(m.diffuseColor[0] * 255).toString(16).padStart(2, "0")}${Math.round(m.diffuseColor[1] * 255).toString(16).padStart(2, "0")}${Math.round(m.diffuseColor[2] * 255).toString(16).padStart(2, "0")}`,
      meta: `Diffuse factor ${m.diffuseFactor.toFixed(2)}${m.embeddedImageIndex !== null ? " · embedded texture" : ""}`,
    }));
  },
};

function applyColorMode(ctx: AdapterContext, result: FBXAdapterResult, options: AdapterDisplayOptions): void {
  if (!mesh) return;
  if (options.colorMode === "original") {
    mesh.material = originalMaterials;
    return;
  }
  if (!singleMaterial) {
    singleMaterial = new ctx.THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0.1, roughness: 0.6, side: ctx.THREE.DoubleSide });
  }
  singleMaterial.color.set(options.colorMode === "neutral" ? options.modelColorHex : "#ffffff");
  singleMaterial.vertexColors = options.colorMode === "vertex-colors" && Boolean(result.colors);
  singleMaterial.wireframe = options.wireframe;
  singleMaterial.needsUpdate = true;
  mesh.material = singleMaterial;
}

export default adapter;
