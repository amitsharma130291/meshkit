/**
 * GLB adapter — wraps `glb-viewer.worker.ts` unchanged. Mirrors
 * `src/pages/glb-viewer/_client.ts`: one shared indexed vertex buffer,
 * `geometry.groups` + a deduplicated per-material array for real
 * per-primitive PBR materials, embedded PNG/JPEG textures decoded on the
 * main thread via `createImageBitmap()` (never in the worker), and
 * separate non-indexed line/point geometries. The universal shell's
 * `AdapterColorMode` only has three values (`original`/`neutral`/
 * `vertex-colors`), so the dedicated GLB viewer's fourth "Color by node"
 * visualization aid isn't offered here — a deliberate, disclosed
 * reduction of the shared shell's own display-mode surface, never of
 * what's actually parsed or rendered (materials and textures still
 * render in full either way).
 */
import { formatTriangleCount } from "../../stl/format";
import type { STLBounds } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { GLBViewerResult as GLBAdapterResult } from "../../glb/viewer-types";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

export type { GLBAdapterResult };

type ThreeModule = typeof import("three");

function segmentKey(index: number): string {
  return `glb:seg:${index}`;
}

let triangleMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let triangleGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let originalMaterials: InstanceType<ThreeModule["Material"]>[] = [];
let neutralMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let vertexColorMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let lineObj: InstanceType<ThreeModule["LineSegments"]> | null = null;
let lineGeo: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let lineMat: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;
let pointObj: InstanceType<ThreeModule["Points"]> | null = null;
let pointGeo: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let pointMat: InstanceType<ThreeModule["PointsMaterial"]> | null = null;
let decodedTextures: (InstanceType<ThreeModule["Texture"]> | null)[] = [];
let decodedBitmaps: (ImageBitmap | null)[] = [];
let lastResult: GLBAdapterResult | null = null;

function disposeAll(): void {
  triangleGeometry?.dispose();
  for (const m of originalMaterials) m.dispose();
  originalMaterials = [];
  neutralMaterial?.dispose();
  neutralMaterial = null;
  vertexColorMaterial?.dispose();
  vertexColorMaterial = null;
  triangleMesh = null;
  triangleGeometry = null;
  lineGeo?.dispose();
  lineMat?.dispose();
  lineObj = null;
  lineGeo = null;
  lineMat = null;
  pointGeo?.dispose();
  pointMat?.dispose();
  pointObj = null;
  pointGeo = null;
  pointMat = null;
  for (const t of decodedTextures) t?.dispose();
  decodedTextures = [];
  for (const b of decodedBitmaps) b?.close();
  decodedBitmaps = [];
}

async function decodeImages(result: GLBAdapterResult): Promise<void> {
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

function buildTextureFor(ctx: AdapterContext, textureIndex: number, result: GLBAdapterResult): InstanceType<ThreeModule["Texture"]> | null {
  const tex = result.textures[textureIndex];
  if (!tex || tex.sourceImageIndex === null) return null;
  const bitmap = decodedBitmaps[tex.sourceImageIndex];
  if (!bitmap) return null;
  const texture = new ctx.THREE.Texture(bitmap);
  texture.colorSpace = ctx.THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  decodedTextures.push(texture);
  return texture;
}

function buildOriginalMaterials(ctx: AdapterContext, result: GLBAdapterResult, options: AdapterDisplayOptions): void {
  const { THREE } = ctx;
  originalMaterials = result.materials.map((m) => {
    const map = m.baseColorTexture ? buildTextureFor(ctx, m.baseColorTexture.textureIndex, result) : null;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2]),
      map,
      transparent: m.baseColorFactor[3] < 1,
      opacity: m.baseColorFactor[3],
      metalness: m.metallicFactor,
      roughness: m.roughnessFactor,
      side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wireframe: options.wireframe,
    });
  });
  originalMaterials.push(new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: options.wireframe }));
}

function rebuildTriangleIndex(ctx: AdapterContext, result: GLBAdapterResult, hidden: ReadonlySet<string>): void {
  if (!triangleGeometry) return;
  const fallbackIdx = originalMaterials.length - 1;
  let total = 0;
  result.segments.forEach((seg, i) => {
    if (seg.renderCategory === "triangles" && !hidden.has(segmentKey(i))) total += seg.indexCount;
  });
  const newIndex = new Uint32Array(total);
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  let offset = 0;
  result.segments.forEach((seg, i) => {
    if (seg.renderCategory !== "triangles" || hidden.has(segmentKey(i))) return;
    for (let k = 0; k < seg.indexCount; k++) newIndex[offset + k] = result.indices[seg.indexStart + k];
    groups.push({ start: offset, count: seg.indexCount, materialIndex: seg.materialIndex ?? fallbackIdx });
    offset += seg.indexCount;
  });
  triangleGeometry.setIndex(new ctx.THREE.BufferAttribute(newIndex, 1));
  triangleGeometry.clearGroups();
  for (const g of groups) triangleGeometry.addGroup(g.start, g.count, g.materialIndex);
}

const adapter: ViewerAdapter<GLBAdapterResult> = {
  format: "glb",
  label: "GLB",
  extensions: ["glb", "gltf"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/glb-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(result: GLBAdapterResult): AdapterCapabilities {
    return {
      wireframe: true,
      shading: false,
      colorModes: ["original", "neutral", ...(result.hasVertexColors ? (["vertex-colors"] as const) : [])],
      segments: true,
      materials: result.materials.length > 0,
      unitNote: "m (glTF convention)",
    };
  },

  async buildScene(ctx: AdapterContext, result: GLBAdapterResult, options: AdapterDisplayOptions): Promise<void> {
    if (triangleMesh) ctx.scene.remove(triangleMesh);
    if (lineObj) ctx.scene.remove(lineObj);
    if (pointObj) ctx.scene.remove(pointObj);
    disposeAll();
    lastResult = result;
    const { THREE } = ctx;

    await decodeImages(result);

    if (result.renderedTriangleCount > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
      if (result.texcoords0) geo.setAttribute("uv", new THREE.BufferAttribute(result.texcoords0, 2));
      buildOriginalMaterials(ctx, result, options);
      const mesh = new THREE.Mesh(geo, originalMaterials);
      ctx.scene.add(mesh);
      triangleMesh = mesh;
      triangleGeometry = geo;
      rebuildTriangleIndex(ctx, result, options.hiddenSegmentKeys);
      applyColorMode(ctx, result, options);
    }

    if (result.lineGeometry) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(result.lineGeometry, 3));
      const mat = new THREE.LineBasicMaterial({ color: "#24b8d8" });
      const lines = new THREE.LineSegments(geo, mat);
      ctx.scene.add(lines);
      lineObj = lines;
      lineGeo = geo;
      lineMat = mat;
    }
    if (result.pointGeometry) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(result.pointGeometry, 3));
      const mat = new THREE.PointsMaterial({ color: "#ed4b93", size: 4, sizeAttenuation: false });
      const points = new THREE.Points(geo, mat);
      ctx.scene.add(points);
      pointObj = points;
      pointGeo = geo;
      pointMat = mat;
    }
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    if (!lastResult) return;
    if (triangleGeometry) rebuildTriangleIndex(ctx, lastResult, options.hiddenSegmentKeys);
    applyColorMode(ctx, lastResult, options);
    for (const m of originalMaterials) {
      if ("wireframe" in m) (m as InstanceType<ThreeModule["MeshStandardMaterial"]>).wireframe = options.wireframe;
    }
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (triangleMesh) ctx.scene.remove(triangleMesh);
    if (lineObj) ctx.scene.remove(lineObj);
    if (pointObj) ctx.scene.remove(pointObj);
    disposeAll();
    lastResult = null;
  },

  fitAllTarget(result: GLBAdapterResult): AdapterFitTarget {
    const [sx, sy, sz] = result.boundsMeters.size;
    return { radius: Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6), center: result.boundsMeters.center };
  },

  fitVisibleTarget(result: GLBAdapterResult, hidden: ReadonlySet<string>): AdapterFitTarget | null {
    const boundsList: STLBounds[] = [];
    result.segments.forEach((seg, i) => {
      if (!hidden.has(segmentKey(i))) boundsList.push(seg.bounds);
    });
    if (boundsList.length === 0) return adapter.fitAllTarget(result);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boundsList) {
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

  info(result: GLBAdapterResult): UniversalInfoField[] {
    return [
      { label: "glTF version", value: result.gltfVersion },
      { label: "Nodes", value: formatTriangleCount(result.nodeCount) },
      { label: "Meshes", value: formatTriangleCount(result.meshCount) },
      { label: "Primitives", value: formatTriangleCount(result.primitiveCount) },
      { label: "Triangles", value: formatTriangleCount(result.renderedTriangleCount) },
      { label: "Lines", value: formatTriangleCount(result.renderedLineCount) },
      { label: "Points", value: formatTriangleCount(result.renderedPointCount) },
      { label: "Materials", value: formatTriangleCount(result.materials.length) },
      { label: "Embedded images", value: formatTriangleCount(result.images.filter((i) => i !== null).length) },
    ];
  },

  dimensions(result: GLBAdapterResult) {
    return {
      width: `${result.boundsMeters.size[0].toFixed(3)} m`,
      height: `${result.boundsMeters.size[1].toFixed(3)} m`,
      depth: `${result.boundsMeters.size[2].toFixed(3)} m`,
    };
  },

  unsupportedFeaturesNote(result: GLBAdapterResult): string | null {
    const parts: string[] = [];
    if (result.animationCount > 0) parts.push("animations");
    if (result.skinCount > 0) parts.push("skins");
    if (result.morphTargetCount > 0) parts.push("morph targets");
    return parts.length > 0 ? `Detected but not applied: ${parts.join(", ")}.` : null;
  },

  warnings(result: GLBAdapterResult) {
    return result.warnings;
  },

  segments(result: GLBAdapterResult): AdapterSegmentRow[] | null {
    if (result.segments.length === 0) return null;
    return result.segments.map((seg, i) => ({
      key: segmentKey(i),
      groupLabel: seg.displayName ?? `Node ${seg.nodeIndex}`,
      rowLabel: `${seg.renderCategory} primitive`,
      countLabel: formatTriangleCount(seg.renderCategory === "triangles" ? seg.indexCount / 3 : seg.indexCount),
      visible: true,
    }));
  },

  materials(result: GLBAdapterResult): AdapterMaterialCard[] | null {
    if (result.materials.length === 0) return null;
    return result.materials.map((m) => ({
      name: m.name ?? "(unnamed material)",
      colorHex: `#${Math.round(m.baseColorFactor[0] * 255).toString(16).padStart(2, "0")}${Math.round(m.baseColorFactor[1] * 255).toString(16).padStart(2, "0")}${Math.round(m.baseColorFactor[2] * 255).toString(16).padStart(2, "0")}`,
      meta: `Metalness ${m.metallicFactor.toFixed(2)} · Roughness ${m.roughnessFactor.toFixed(2)}${m.baseColorTexture ? " · base-color texture" : ""}`,
    }));
  },
};

function applyColorMode(ctx: AdapterContext, result: GLBAdapterResult, options: AdapterDisplayOptions): void {
  if (!triangleMesh || !triangleGeometry) return;
  const { THREE } = ctx;
  if (options.colorMode === "original") {
    triangleGeometry.deleteAttribute("color");
    if (result.colors0) triangleGeometry.setAttribute("color", new THREE.BufferAttribute(result.colors0, 4));
    triangleMesh.material = originalMaterials;
  } else if (options.colorMode === "vertex-colors" && result.hasVertexColors) {
    if (!vertexColorMaterial) vertexColorMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
    triangleGeometry.deleteAttribute("color");
    if (result.colors0) triangleGeometry.setAttribute("color", new THREE.BufferAttribute(result.colors0, 4));
    vertexColorMaterial.wireframe = options.wireframe;
    triangleMesh.material = vertexColorMaterial;
  } else {
    if (!neutralMaterial) neutralMaterial = new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide });
    neutralMaterial.color.set(options.modelColorHex);
    neutralMaterial.wireframe = options.wireframe;
    triangleMesh.material = neutralMaterial;
  }
}

export default adapter;
