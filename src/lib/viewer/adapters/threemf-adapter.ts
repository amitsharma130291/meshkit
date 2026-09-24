/**
 * 3MF adapter — wraps `threemf-viewer.worker.ts` unchanged. Mirrors
 * `src/pages/3mf-viewer/_client.ts`: non-indexed, per-corner triangle
 * geometry (same index-buffer-rebuild-per-visible-segment technique as
 * OBJ's adapter), embedded base-material/color-group colors when
 * present, and dimensions preserved in the file's own declared unit
 * (converted to millimeters for reference) — never relabeled as a unit
 * the file didn't declare.
 */
import { formatMagnitude, formatTriangleCount } from "../../stl/format";
import type { STLBounds } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { ThreeMFViewerResult as ThreeMFAdapterResult } from "../../threemf/viewer-types";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

export type { ThreeMFAdapterResult };

type ThreeModule = typeof import("three");

let mesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let geometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let originalMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let neutralMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let lastResult: ThreeMFAdapterResult | null = null;

function segmentKey(index: number): string {
  return `3mf:seg:${index}`;
}

function disposeAll(): void {
  geometry?.dispose();
  originalMaterial?.dispose();
  neutralMaterial?.dispose();
  mesh = null;
  geometry = null;
  originalMaterial = null;
  neutralMaterial = null;
}

function rebuildIndex(ctx: AdapterContext, result: ThreeMFAdapterResult, hidden: ReadonlySet<string>): void {
  if (!geometry) return;
  const { THREE } = ctx;
  let total = 0;
  result.segments.forEach((seg, i) => {
    if (!hidden.has(segmentKey(i))) total += seg.triangleCount * 3;
  });
  const index = new Uint32Array(total);
  let offset = 0;
  result.segments.forEach((seg, i) => {
    if (hidden.has(segmentKey(i))) return;
    const start = seg.triangleStart * 3;
    const count = seg.triangleCount * 3;
    for (let k = 0; k < count; k++) index[offset + k] = start + k;
    offset += count;
  });
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
}

const adapter: ViewerAdapter<ThreeMFAdapterResult> = {
  format: "3mf",
  label: "3MF",
  extensions: ["3mf"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/threemf-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(result: ThreeMFAdapterResult): AdapterCapabilities {
    return {
      wireframe: true,
      shading: false,
      colorModes: result.hasEmbeddedColors ? ["original", "neutral"] : [],
      segments: true,
      materials: false,
      unitNote: `${result.declaredUnit} (declared)`,
    };
  },

  async buildScene(ctx: AdapterContext, result: ThreeMFAdapterResult, options: AdapterDisplayOptions): Promise<void> {
    if (mesh) ctx.scene.remove(mesh);
    disposeAll();
    lastResult = result;
    const { THREE } = ctx;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    if (result.colors) geo.setAttribute("color", new THREE.BufferAttribute(result.colors, 3));

    const useOriginal = options.colorMode !== "neutral" && result.hasEmbeddedColors;
    let mat: InstanceType<typeof THREE.MeshStandardMaterial>;
    if (useOriginal) {
      mat = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, wireframe: options.wireframe });
      originalMaterial = mat;
    } else {
      mat = new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: options.wireframe });
      neutralMaterial = mat;
    }

    const m = new THREE.Mesh(geo, mat);
    ctx.scene.add(m);
    mesh = m;
    geometry = geo;
    rebuildIndex(ctx, result, options.hiddenSegmentKeys);
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    if (!lastResult || !geometry || !mesh) return;
    const useOriginal = options.colorMode !== "neutral" && lastResult.hasEmbeddedColors;
    if (useOriginal) {
      if (!originalMaterial) {
        originalMaterial = new ctx.THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.6, side: ctx.THREE.DoubleSide });
      }
      originalMaterial.wireframe = options.wireframe;
      mesh.material = originalMaterial;
    } else {
      if (!neutralMaterial) {
        neutralMaterial = new ctx.THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: ctx.THREE.DoubleSide });
      }
      neutralMaterial.color.set(options.modelColorHex);
      neutralMaterial.wireframe = options.wireframe;
      mesh.material = neutralMaterial;
    }
    rebuildIndex(ctx, lastResult, options.hiddenSegmentKeys);
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (mesh) ctx.scene.remove(mesh);
    disposeAll();
    lastResult = null;
  },

  fitAllTarget(result: ThreeMFAdapterResult): AdapterFitTarget {
    const [sx, sy, sz] = result.boundsMillimeters.size;
    return { radius: Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6), center: result.boundsMillimeters.center };
  },

  fitVisibleTarget(result: ThreeMFAdapterResult, hidden: ReadonlySet<string>): AdapterFitTarget | null {
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

  info(result: ThreeMFAdapterResult): UniversalInfoField[] {
    return [
      { label: "Mesh objects", value: formatTriangleCount(result.meshObjectCount) },
      { label: "Build items", value: formatTriangleCount(result.buildItemCount) },
      { label: "Resolved instances", value: formatTriangleCount(result.resolvedInstanceCount) },
      { label: "Triangles", value: formatTriangleCount(result.triangleCount) },
      { label: "Declared unit", value: result.declaredUnit },
      { label: "Embedded colors", value: result.hasEmbeddedColors ? "Present" : "Not available" },
    ];
  },

  dimensions(result: ThreeMFAdapterResult) {
    return {
      width: `${formatMagnitude(result.boundsMillimeters.size[0])} mm`,
      height: `${formatMagnitude(result.boundsMillimeters.size[1])} mm`,
      depth: `${formatMagnitude(result.boundsMillimeters.size[2])} mm`,
    };
  },

  unsupportedFeaturesNote(): string | null {
    return "Textures are detected and disclosed, but never rendered or fetched.";
  },

  warnings(result: ThreeMFAdapterResult) {
    return result.warnings;
  },

  segments(result: ThreeMFAdapterResult): AdapterSegmentRow[] | null {
    if (result.segments.length === 0) return null;
    return result.segments.map((seg, i) => ({
      key: segmentKey(i),
      groupLabel: seg.displayName ?? `Object ${seg.meshObjectId}`,
      rowLabel: seg.componentPath.length > 0 ? `Component instance (depth ${seg.componentPath.length})` : "Direct build item",
      countLabel: formatTriangleCount(seg.triangleCount),
      visible: true,
    }));
  },

  materials(): AdapterMaterialCard[] | null {
    return null;
  },
};

export default adapter;
