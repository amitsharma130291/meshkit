/**
 * PLY adapter — wraps `ply-viewer.worker.ts` unchanged. Mirrors
 * `src/pages/ply-viewer/_client.ts`: up to three independent objects
 * (surface `Mesh`, explicit-edge `LineSegments`, `Points`) sharing the
 * *same* position/color/normal `BufferAttribute` instances rather than
 * duplicating them per category, with visibility a plain `.visible`
 * toggle (PLY has no sub-category granularity to rebuild an index for).
 */
import { formatMagnitude, formatTriangleCount } from "../../stl/format";
import type { STLBounds } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { PLYViewerResult as PLYAdapterResult } from "../../ply/viewer-types";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

export type { PLYAdapterResult };

type ThreeModule = typeof import("three");

const SURFACE_KEY = "ply:surface";
const EDGES_KEY = "ply:edges";
const POINTS_KEY = "ply:points";

let surfaceMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let surfaceGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let surfaceMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let edgesObj: InstanceType<ThreeModule["LineSegments"]> | null = null;
let edgesGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let edgesMaterial: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;
let pointsObj: InstanceType<ThreeModule["Points"]> | null = null;
let pointsGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let pointsMaterial: InstanceType<ThreeModule["PointsMaterial"]> | null = null;

function disposeAll(): void {
  surfaceGeometry?.dispose();
  surfaceMaterial?.dispose();
  surfaceMesh = null;
  surfaceGeometry = null;
  surfaceMaterial = null;
  edgesGeometry?.dispose();
  edgesMaterial?.dispose();
  edgesObj = null;
  edgesGeometry = null;
  edgesMaterial = null;
  pointsGeometry?.dispose();
  pointsMaterial?.dispose();
  pointsObj = null;
  pointsGeometry = null;
  pointsMaterial = null;
}

const adapter: ViewerAdapter<PLYAdapterResult> = {
  format: "ply",
  label: "PLY",
  extensions: ["ply"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/ply-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(result: PLYAdapterResult): AdapterCapabilities {
    return {
      wireframe: Boolean(result.surfaceIndices),
      shading: Boolean(result.surfaceIndices),
      colorModes: result.hasVertexColors ? ["vertex-colors", "neutral"] : [],
      segments: true,
      materials: false,
      unitNote: "model units",
    };
  },

  async buildScene(ctx: AdapterContext, result: PLYAdapterResult, options: AdapterDisplayOptions): Promise<void> {
    if (surfaceMesh) ctx.scene.remove(surfaceMesh);
    if (edgesObj) ctx.scene.remove(edgesObj);
    if (pointsObj) ctx.scene.remove(pointsObj);
    disposeAll();
    const { THREE } = ctx;

    const positionAttr = new THREE.BufferAttribute(result.positions, 3);
    const colorAttr = result.colors ? new THREE.BufferAttribute(result.colors, 4) : null;
    const normalAttr = result.normals ? new THREE.BufferAttribute(result.normals, 3) : null;
    const useVertexColors = options.colorMode === "vertex-colors" && Boolean(colorAttr);

    if (result.surfaceIndices) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", positionAttr);
      if (normalAttr) geo.setAttribute("normal", normalAttr);
      if (colorAttr) geo.setAttribute("color", colorAttr);
      geo.setIndex(new THREE.BufferAttribute(result.surfaceIndices, 1));
      const mat = new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, vertexColors: useVertexColors, flatShading: options.shadingMode === "flat", wireframe: options.wireframe });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = !options.hiddenSegmentKeys.has(SURFACE_KEY);
      ctx.scene.add(mesh);
      surfaceMesh = mesh;
      surfaceGeometry = geo;
      surfaceMaterial = mat;
    }

    if (result.edgeIndices) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", positionAttr);
      if (colorAttr) geo.setAttribute("color", colorAttr);
      geo.setIndex(new THREE.BufferAttribute(result.edgeIndices, 1));
      const mat = new THREE.LineBasicMaterial({ color: options.modelColorHex, vertexColors: useVertexColors });
      const lines = new THREE.LineSegments(geo, mat);
      lines.visible = !options.hiddenSegmentKeys.has(EDGES_KEY);
      ctx.scene.add(lines);
      edgesObj = lines;
      edgesGeometry = geo;
      edgesMaterial = mat;
    }

    {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", positionAttr);
      if (colorAttr) geo.setAttribute("color", colorAttr);
      const mat = new THREE.PointsMaterial({ color: options.modelColorHex, size: 4, sizeAttenuation: false, vertexColors: useVertexColors });
      const points = new THREE.Points(geo, mat);
      points.visible = !options.hiddenSegmentKeys.has(POINTS_KEY);
      ctx.scene.add(points);
      pointsObj = points;
      pointsGeometry = geo;
      pointsMaterial = mat;
    }
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    const useVertexColors = options.colorMode === "vertex-colors";
    if (surfaceMaterial) {
      surfaceMaterial.vertexColors = useVertexColors;
      surfaceMaterial.color.set(options.modelColorHex);
      surfaceMaterial.wireframe = options.wireframe;
      surfaceMaterial.flatShading = options.shadingMode === "flat";
      surfaceMaterial.needsUpdate = true;
    }
    if (edgesMaterial) {
      edgesMaterial.vertexColors = useVertexColors;
      edgesMaterial.color.set(options.modelColorHex);
      edgesMaterial.needsUpdate = true;
    }
    if (pointsMaterial) {
      pointsMaterial.vertexColors = useVertexColors;
      pointsMaterial.color.set(options.modelColorHex);
      pointsMaterial.needsUpdate = true;
    }
    if (surfaceMesh) surfaceMesh.visible = !options.hiddenSegmentKeys.has(SURFACE_KEY);
    if (edgesObj) edgesObj.visible = !options.hiddenSegmentKeys.has(EDGES_KEY);
    if (pointsObj) pointsObj.visible = !options.hiddenSegmentKeys.has(POINTS_KEY);
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (surfaceMesh) ctx.scene.remove(surfaceMesh);
    if (edgesObj) ctx.scene.remove(edgesObj);
    if (pointsObj) ctx.scene.remove(pointsObj);
    disposeAll();
  },

  fitAllTarget(result: PLYAdapterResult): AdapterFitTarget {
    const [sx, sy, sz] = result.boundsModelUnits.size;
    return { radius: Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6), center: result.boundsModelUnits.center };
  },

  fitVisibleTarget(result: PLYAdapterResult, hidden: ReadonlySet<string>): AdapterFitTarget | null {
    const list: STLBounds[] = [];
    if (!hidden.has(SURFACE_KEY) && result.boundsSurface) list.push(result.boundsSurface);
    if (!hidden.has(EDGES_KEY) && result.boundsEdges) list.push(result.boundsEdges);
    if (!hidden.has(POINTS_KEY) && result.boundsPoints) list.push(result.boundsPoints);
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

  info(result: PLYAdapterResult): UniversalInfoField[] {
    return [
      { label: "Encoding", value: result.format },
      { label: "Vertices", value: formatTriangleCount(result.sourceVertexCount) },
      { label: "Rendered triangles", value: formatTriangleCount(result.renderedTriangleCount) },
      { label: "Explicit edges", value: formatTriangleCount(result.edgeCount) },
      { label: "Rendered points", value: formatTriangleCount(result.renderedPointCount) },
      { label: "Source normals", value: result.hasSourceNormals ? "Present and used" : "Not available" },
      { label: "Vertex colors", value: result.hasVertexColors ? "Present" : "Not available" },
    ];
  },

  dimensions(result: PLYAdapterResult) {
    return {
      width: `${formatMagnitude(result.boundsModelUnits.size[0])} model units`,
      height: `${formatMagnitude(result.boundsModelUnits.size[1])} model units`,
      depth: `${formatMagnitude(result.boundsModelUnits.size[2])} model units`,
    };
  },

  unsupportedFeaturesNote(result: PLYAdapterResult): string | null {
    return result.hasTextureCoordinates ? "Texture coordinates are present as metadata only — PLY has no texture image to sample them against." : null;
  },

  warnings(result: PLYAdapterResult) {
    return result.warnings;
  },

  segments(result: PLYAdapterResult): AdapterSegmentRow[] | null {
    const rows: AdapterSegmentRow[] = [];
    if (result.surfaceIndices) rows.push({ key: SURFACE_KEY, groupLabel: "Geometry", rowLabel: "Surface", countLabel: formatTriangleCount(result.renderedTriangleCount), visible: true });
    if (result.edgeIndices) rows.push({ key: EDGES_KEY, groupLabel: "Geometry", rowLabel: "Explicit edges", countLabel: formatTriangleCount(result.edgeCount), visible: true });
    rows.push({ key: POINTS_KEY, groupLabel: "Geometry", rowLabel: "Points", countLabel: formatTriangleCount(result.renderedPointCount), visible: true });
    return rows;
  },

  materials(): AdapterMaterialCard[] | null {
    return null;
  },
};

export default adapter;
