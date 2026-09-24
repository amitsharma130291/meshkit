/**
 * OBJ adapter — wraps `obj-viewer.worker.ts` unchanged. Mirrors
 * `src/pages/obj-viewer/_client.ts`: non-indexed, per-corner triangle
 * geometry with an identity `indices` buffer rebuilt per visible segment
 * (never a second, deduplicated vertex buffer), a dual-normal-array
 * shading toggle (`normals` vs. `flatNormals`, not a material-level
 * `flatShading` flag — OBJ's own viewer precomputes both), and separate
 * non-indexed line/point geometries shown as two synthetic, always-present
 * segment rows rather than one row per line/point (OBJ's own segment list
 * only ever tracks triangle runs).
 */
import { formatMagnitude, formatTriangleCount } from "../../stl/format";
import type { STLBounds } from "../../stl/types";
import type { WorkerLike } from "../../workers/worker-client";
import type { OBJViewerResult as OBJAdapterResult } from "../../obj/viewer-types";
import type { AdapterCapabilities, AdapterContext, AdapterDisplayOptions, AdapterFitTarget, AdapterSegmentRow, AdapterMaterialCard, UniversalInfoField, ViewerAdapter } from "../adapter-types";

export type { OBJAdapterResult };

type ThreeModule = typeof import("three");

const LINES_KEY = "obj:lines";
const POINTS_KEY = "obj:points";

let triangleMesh: InstanceType<ThreeModule["Mesh"]> | null = null;
let triangleGeometry: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let triangleMaterial: InstanceType<ThreeModule["MeshStandardMaterial"]> | null = null;
let lineObj: InstanceType<ThreeModule["LineSegments"]> | null = null;
let lineGeo: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let lineMat: InstanceType<ThreeModule["LineBasicMaterial"]> | null = null;
let pointObj: InstanceType<ThreeModule["Points"]> | null = null;
let pointGeo: InstanceType<ThreeModule["BufferGeometry"]> | null = null;
let pointMat: InstanceType<ThreeModule["PointsMaterial"]> | null = null;
let lastResult: OBJAdapterResult | null = null;

function disposeAll(): void {
  triangleGeometry?.dispose();
  triangleMaterial?.dispose();
  triangleMesh = null;
  triangleGeometry = null;
  triangleMaterial = null;
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
}

function segmentKey(index: number): string {
  return `obj:seg:${index}`;
}

function rebuildTriangleIndex(ctx: AdapterContext, result: OBJAdapterResult, hidden: ReadonlySet<string>): void {
  if (!triangleGeometry) return;
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
  triangleGeometry.setIndex(new THREE.BufferAttribute(index, 1));
}

const adapter: ViewerAdapter<OBJAdapterResult> = {
  format: "obj",
  label: "OBJ",
  extensions: ["obj"],

  createWorker(): WorkerLike {
    const worker = new Worker(new URL("../../../workers/obj-viewer.worker.ts", import.meta.url), { type: "module" });
    return worker as unknown as WorkerLike;
  },

  capabilities(result: OBJAdapterResult): AdapterCapabilities {
    return {
      wireframe: true,
      shading: result.hasValidSourceNormals,
      colorModes: [],
      segments: true,
      materials: false,
      unitNote: "model units",
    };
  },

  async buildScene(ctx: AdapterContext, result: OBJAdapterResult, options: AdapterDisplayOptions): Promise<void> {
    if (triangleMesh) ctx.scene.remove(triangleMesh);
    if (lineObj) ctx.scene.remove(lineObj);
    if (pointObj) ctx.scene.remove(pointObj);
    disposeAll();
    lastResult = result;
    const { THREE } = ctx;

    if (result.positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(options.shadingMode === "flat" ? result.flatNormals : result.normals, 3));
      const mat = new THREE.MeshStandardMaterial({ color: options.modelColorHex, metalness: 0.12, roughness: 0.55, side: THREE.DoubleSide, wireframe: options.wireframe });
      const mesh = new THREE.Mesh(geo, mat);
      ctx.scene.add(mesh);
      triangleMesh = mesh;
      triangleGeometry = geo;
      triangleMaterial = mat;
      rebuildTriangleIndex(ctx, result, options.hiddenSegmentKeys);
    }

    if (result.lineGeometry) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(result.lineGeometry, 3));
      const mat = new THREE.LineBasicMaterial({ color: "#24b8d8" });
      const lines = new THREE.LineSegments(geo, mat);
      lines.visible = !options.hiddenSegmentKeys.has(LINES_KEY);
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
      points.visible = !options.hiddenSegmentKeys.has(POINTS_KEY);
      ctx.scene.add(points);
      pointObj = points;
      pointGeo = geo;
      pointMat = mat;
    }
  },

  applyDisplayOptions(ctx: AdapterContext, options: AdapterDisplayOptions): void {
    if (triangleMaterial) triangleMaterial.wireframe = options.wireframe;
    if (triangleMaterial) triangleMaterial.color.set(options.modelColorHex);
    if (triangleGeometry && lastResult) {
      triangleGeometry.setAttribute("normal", new ctx.THREE.BufferAttribute(options.shadingMode === "flat" ? lastResult.flatNormals : lastResult.normals, 3));
      rebuildTriangleIndex(ctx, lastResult, options.hiddenSegmentKeys);
    }
    if (lineObj) lineObj.visible = !options.hiddenSegmentKeys.has(LINES_KEY);
    if (pointObj) pointObj.visible = !options.hiddenSegmentKeys.has(POINTS_KEY);
    ctx.requestRender();
  },

  disposeScene(ctx: AdapterContext): void {
    if (triangleMesh) ctx.scene.remove(triangleMesh);
    if (lineObj) ctx.scene.remove(lineObj);
    if (pointObj) ctx.scene.remove(pointObj);
    disposeAll();
    lastResult = null;
  },

  fitAllTarget(result: OBJAdapterResult): AdapterFitTarget {
    const [sx, sy, sz] = result.bounds.size;
    return { radius: Math.max(Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2 + (sz / 2) ** 2), 1e-6), center: result.bounds.center };
  },

  fitVisibleTarget(result: OBJAdapterResult, hidden: ReadonlySet<string>): AdapterFitTarget | null {
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

  info(result: OBJAdapterResult): UniversalInfoField[] {
    return [
      { label: "Objects", value: formatTriangleCount(result.objectCount) },
      { label: "Groups", value: formatTriangleCount(result.groupCount) },
      { label: "Triangles", value: formatTriangleCount(result.triangleCount) },
      { label: "Lines", value: formatTriangleCount(result.lineCount) },
      { label: "Points", value: formatTriangleCount(result.pointCount) },
      { label: "Referenced materials", value: result.usedMaterialCount > 0 ? result.usedMaterialNames.join(", ") : "None" },
      { label: "Source normals", value: result.hasValidSourceNormals ? "Present and used" : "Not available" },
    ];
  },

  dimensions(result: OBJAdapterResult) {
    return {
      width: `${formatMagnitude(result.bounds.size[0])} model units`,
      height: `${formatMagnitude(result.bounds.size[1])} model units`,
      depth: `${formatMagnitude(result.bounds.size[2])} model units`,
    };
  },

  unsupportedFeaturesNote(result: OBJAdapterResult): string | null {
    return result.usedMaterialCount > 0 ? "Materials and textures referenced by this file are shown by name only — never fetched or rendered." : null;
  },

  warnings(result: OBJAdapterResult) {
    return result.warnings;
  },

  segments(result: OBJAdapterResult): AdapterSegmentRow[] | null {
    const rows: AdapterSegmentRow[] = result.segments.map((seg, i) => ({
      key: segmentKey(i),
      groupLabel: seg.objectName || "(default)",
      rowLabel: seg.groupNames.length > 0 ? seg.groupNames.join(", ") : "(no group)",
      countLabel: formatTriangleCount(seg.triangleCount),
      visible: true,
    }));
    if (result.lineGeometry) rows.push({ key: LINES_KEY, groupLabel: "Lines", rowLabel: "Line geometry", countLabel: formatTriangleCount(result.lineCount), visible: true });
    if (result.pointGeometry) rows.push({ key: POINTS_KEY, groupLabel: "Points", rowLabel: "Point geometry", countLabel: formatTriangleCount(result.pointCount), visible: true });
    return rows.length > 0 ? rows : null;
  },

  materials(): AdapterMaterialCard[] | null {
    return null;
  },
};

export default adapter;
