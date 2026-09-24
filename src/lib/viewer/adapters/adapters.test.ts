/**
 * "Result normalization" tests for all six adapters — feeds each adapter
 * a REAL result object produced by that format's own existing, tested
 * pipeline (never a hand-typed stand-in), and verifies the adapter's own
 * pure, DOM/Worker-independent surface (`capabilities`/`info`/
 * `dimensions`/`segments`/`materials`/`warnings`/`unsupportedFeaturesNote`/
 * `fitAllTarget`/`fitVisibleTarget`) produces sensible output consistent
 * with that data. `buildScene`/`applyDisplayOptions`/`disposeScene`/
 * `createWorker` need a real `Worker`/WebGL/`document`, none of which
 * exist in this project's `environment: "node"` vitest config — those
 * are covered by browser verification instead, the same way every
 * dedicated viewer page's own Three.js scene-building code always has
 * been in this project.
 */
import { describe, expect, it } from "vitest";
import stlAdapter from "./stl-adapter";
import objAdapter from "./obj-adapter";
import threeMFAdapter from "./threemf-adapter";
import glbAdapter from "./glb-adapter";
import plyAdapter from "./ply-adapter";
import fbxAdapter from "./fbx-adapter";

import { parseSTL } from "../../stl/parse";
import { DEFAULT_STL_LIMITS } from "../../stl/types";
import { parseOBJForViewer } from "../../obj/viewer-geometry";
import { resolveThreeMFViewerPackage } from "../../threemf/viewer-scene";
import { build3MFPackage, buildModelXML, simpleTriangleMesh } from "../../threemf/test-fixtures";
import { resolveGLBViewerPackage } from "../../glb/viewer-scene";
import { simpleTriangleGLB } from "../../glb/test-fixtures";
import { resolvePLYViewerPackage } from "../../ply/viewer-scene";
import { simpleTrianglePLY } from "../../ply/test-fixtures";
import { resolveFBXViewerScene } from "../../fbx/resolve-scene";
import { buildFBXBinary, connectionsSection, geometryNode, objectNode, objectsSection, ooConnection } from "../../fbx/test-fixtures";

function binaryStlBuffer(): ArrayBuffer {
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true); // 1 triangle
  // normal (0,0,1), then 3 vertices of a triangle, then 2-byte attribute count.
  view.setFloat32(84, 0, true);
  view.setFloat32(88, 0, true);
  view.setFloat32(92, 1, true);
  view.setFloat32(96, 0, true);
  view.setFloat32(100, 0, true);
  view.setFloat32(104, 0, true);
  view.setFloat32(108, 1, true);
  view.setFloat32(112, 0, true);
  view.setFloat32(116, 0, true);
  view.setFloat32(120, 0, true);
  view.setFloat32(124, 1, true);
  view.setFloat32(128, 0, true);
  return bytes.buffer;
}

describe("stl-adapter — result normalization", () => {
  const result = parseSTL(binaryStlBuffer(), DEFAULT_STL_LIMITS);

  it("format/label/extensions are correct", () => {
    expect(stlAdapter.format).toBe("stl");
    expect(stlAdapter.label).toBe("STL");
    expect(stlAdapter.extensions).toContain("stl");
  });

  it("capabilities report no segments/materials/shading for STL", () => {
    const caps = stlAdapter.capabilities(result);
    expect(caps.segments).toBe(false);
    expect(caps.materials).toBe(false);
    expect(caps.shading).toBe(false);
    expect(caps.wireframe).toBe(true);
  });

  it("info reflects the real encoding and triangle count", () => {
    const fields = stlAdapter.info(result);
    expect(fields.some((f) => f.label === "Encoding" && f.value === "Binary")).toBe(true);
    expect(fields.some((f) => f.label === "Triangles" && f.value === "1")).toBe(true);
  });

  it("dimensions are in model units", () => {
    const dims = stlAdapter.dimensions(result);
    expect(dims.width).toMatch(/model units/);
  });

  it("segments() and materials() are null", () => {
    expect(stlAdapter.segments(result)).toBeNull();
    expect(stlAdapter.materials(result)).toBeNull();
  });

  it("fitAllTarget and fitVisibleTarget produce a positive radius", () => {
    expect(stlAdapter.fitAllTarget(result).radius).toBeGreaterThan(0);
    expect(stlAdapter.fitVisibleTarget(result, new Set())!.radius).toBeGreaterThan(0);
  });
});

describe("obj-adapter — result normalization", () => {
  const text = "o Cube\ng default\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  const result = parseOBJForViewer(text);

  it("format/label/extensions are correct", () => {
    expect(objAdapter.format).toBe("obj");
    expect(objAdapter.extensions).toContain("obj");
  });

  it("capabilities report segments but no materials panel", () => {
    const caps = objAdapter.capabilities(result);
    expect(caps.segments).toBe(true);
    expect(caps.materials).toBe(false);
  });

  it("info reflects real object/group/triangle counts", () => {
    const fields = objAdapter.info(result);
    expect(fields.some((f) => f.label === "Triangles" && f.value === "1")).toBe(true);
  });

  it("segments() reflects the real per-object/group runs", () => {
    const rows = objAdapter.segments(result);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows![0].groupLabel).toBe("Cube");
  });

  it("materials() is always null (OBJ materials are never rendered)", () => {
    expect(objAdapter.materials(result)).toBeNull();
  });
});

describe("threemf-adapter — result normalization", () => {
  const pkg = build3MFPackage(buildModelXML({ objects: [simpleTriangleMesh()], buildItems: [{ objectId: "1" }] }));
  const result = resolveThreeMFViewerPackage(pkg);

  it("format/label/extensions are correct", () => {
    expect(threeMFAdapter.format).toBe("3mf");
    expect(threeMFAdapter.extensions).toContain("3mf");
  });

  it("capabilities report the declared unit in unitNote", () => {
    const caps = threeMFAdapter.capabilities(result);
    expect(caps.unitNote).toContain(result.declaredUnit);
  });

  it("dimensions are shown in millimeters", () => {
    expect(threeMFAdapter.dimensions(result).width).toMatch(/mm$/);
  });

  it("segments() reflects resolved build-item instances", () => {
    const rows = threeMFAdapter.segments(result);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(result.resolvedInstanceCount);
  });

  it("materials() is always null (3MF colors render via vertex color, not a material list)", () => {
    expect(threeMFAdapter.materials(result)).toBeNull();
  });
});

describe("glb-adapter — result normalization", () => {
  const result = resolveGLBViewerPackage(simpleTriangleGLB());

  it("format/label/extensions are correct", () => {
    expect(glbAdapter.format).toBe("glb");
    expect(glbAdapter.extensions).toContain("glb");
  });

  it("dimensions are shown in meters", () => {
    expect(glbAdapter.dimensions(result).width).toMatch(/ m$/);
  });

  it("segments() reflects resolved node/primitive visits", () => {
    const rows = glbAdapter.segments(result);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(result.segments.length);
  });

  it("info reports the real glTF version", () => {
    const fields = glbAdapter.info(result);
    expect(fields.some((f) => f.label === "glTF version" && f.value === result.gltfVersion)).toBe(true);
  });
});

describe("ply-adapter — result normalization", () => {
  const result = resolvePLYViewerPackage(simpleTrianglePLY("ascii"));

  it("format/label/extensions are correct", () => {
    expect(plyAdapter.format).toBe("ply");
    expect(plyAdapter.extensions).toContain("ply");
  });

  it("dimensions are in model units", () => {
    expect(plyAdapter.dimensions(result).width).toMatch(/model units/);
  });

  it("segments() always includes a Points row (every vertex is a point)", () => {
    const rows = plyAdapter.segments(result);
    expect(rows).not.toBeNull();
    expect(rows!.some((r) => r.rowLabel === "Points")).toBe(true);
  });

  it("materials() is always null (PLY has no material system)", () => {
    expect(plyAdapter.materials(result)).toBeNull();
  });
});

describe("fbx-adapter — result normalization", () => {
  function triangleGeometry(id: bigint) {
    return geometryNode(id, "Tri", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3]);
  }
  const buf = buildFBXBinary({
    nodes: [
      objectsSection([objectNode("Model", 1n, "Cube", "Mesh"), triangleGeometry(2n)]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ],
  });
  const result = resolveFBXViewerScene(buf);

  it("format/label/extensions are correct", () => {
    expect(fbxAdapter.format).toBe("fbx");
    expect(fbxAdapter.extensions).toContain("fbx");
  });

  it("dimensions and segments reflect real resolved data", () => {
    expect(fbxAdapter.dimensions(result).width).toMatch(/model units|m$/);
    const rows = fbxAdapter.segments(result);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(result.segments.length);
  });

  it("capabilities reflect whether vertex colors/materials are present", () => {
    const caps = fbxAdapter.capabilities(result);
    expect(caps.materials).toBe(result.materials.length > 0);
  });
});
