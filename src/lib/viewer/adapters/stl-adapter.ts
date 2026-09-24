/**
 * STL adapter — wraps `stl-viewer.worker.ts` unchanged. STL is the
 * simplest of the six formats: one mesh, no scene graph, no materials,
 * no declared unit. Mirrors `src/pages/stl-viewer/_client.ts`'s own
 * `buildMeshFromResult`, trimmed to the adapter contract.
 */
import { formatMagnitude, formatTriangleCount } from "../../stl/format";
import type { STLParseResult } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

type ThreeModule = typeof import("three");


let mesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let geometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let material: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;

function disposeScene(): void {
  mesh = null;
  geometry?.dispose();
  geometry = null;
  material?.dispose();
  material = null;
}

const adapter: ViewerAdapter<STLParseResult> = {
  format: "stl",
  label: "STL",
  extensions: ["stl"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/stl-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(): AdapterCapabilities {
    return { wireframe: true, shading: false, colorModes: [], segments: false, materials: false, unitNote: "model units" };
  },

  async buildScene(ctx: AdapterContext, result: STLParseResult, options: AdapterDisplayOptions): Promise<void> {
    if (mesh) ctx.scene.remove(mesh);
    disposeScene();
    const { THREE } = ctx;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));

    const mat = new THREE.MeshStandardMaterial({
      color: options.modelColorHex,
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      wireframe: options.wireframe,
    });

    const m = new THREE.Mesh(geo, mat);
    ctx.scene.add(m);
    mesh = m;
    geometry = geo;
    material = mat;
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    if (material) {
      material.wireframe = options.wireframe;
      material.color.set(options.modelColorHex);
    }
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (mesh) ctx.scene.remove(mesh);
    disposeScene();
  },

  fitAllTarget(result: STLParseResult): AdapterFitTarget {
    const [sx, sy, sz] = result.bounds.size;
    const radius = Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6);
    return { radius, center: result.bounds.center };
  },

  fitVisibleTarget(result: STLParseResult): AdapterFitTarget | null {
    return adapter.fitAllTarget(result);
  },

  info(result: STLParseResult): UniversalInfoField[] {
    return [
      { label: "Encoding", value: result.encoding === "binary" ? "Binary" : "ASCII" },
      { label: "Triangles", value: formatTriangleCount(result.triangleCount) },
    ];
  },

  dimensions(result: STLParseResult) {
    return {
      width: `${formatMagnitude(result.bounds.size[0])} model units`,
      height: `${formatMagnitude(result.bounds.size[1])} model units`,
      depth: `${formatMagnitude(result.bounds.size[2])} model units`,
    };
  },

  unsupportedFeaturesNote(): string | null {
    return null;
  },

  warnings(): { message: string }[] {
    return [];
  },

  segments(): AdapterSegmentRow[] | null {
    return null;
  },

  materials(): AdapterMaterialCard[] | null {
    return null;
  },
};

export default adapter;
