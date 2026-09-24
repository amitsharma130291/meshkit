/**
 * End-to-end pipeline tests for `/viewer/`, covering everything up to
 * (but not including) actual Three.js scene construction: detect a real
 * fixture buffer's format → load the matching adapter → feed the
 * REAL worker-pipeline result through that adapter's own normalization
 * functions. This is the full non-rendering half of what `_client.ts`
 * does for every file selection. Three.js scene construction/disposal
 * itself needs a real `Worker`/WebGL/`document`, none of which this
 * project's `environment: "node"` vitest config provides — that half is
 * covered by browser verification instead (see the Phase 4F completion
 * report), the same way it always has been for every dedicated viewer
 * page's own scene-building code in this project.
 */
import { describe, expect, it } from "vitest";
import { detectFormat } from "./format-detection";
import { ADAPTER_LOADERS } from "./adapter-registry";

import { parseSTL } from "../stl/parse";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { parseOBJForViewer } from "../obj/viewer-geometry";
import { resolveThreeMFViewerPackage } from "../threemf/viewer-scene";
import { build3MFPackage, buildModelXML, simpleTriangleMesh } from "../threemf/test-fixtures";
import { resolveGLBViewerPackage } from "../glb/viewer-scene";
import { simpleTriangleGLB } from "../glb/test-fixtures";
import { resolvePLYViewerPackage } from "../ply/viewer-scene";
import { simpleTrianglePLY } from "../ply/test-fixtures";
import { resolveFBXViewerScene } from "../fbx/resolve-scene";
import { buildFBXBinary, connectionsSection, geometryNode, objectNode, objectsSection, ooConnection } from "../fbx/test-fixtures";

function binaryStlBuffer(): ArrayBuffer {
  const bytes = new Uint8Array(84 + 50);
  new DataView(bytes.buffer).setUint32(80, 1, true);
  return bytes.buffer;
}

function objBuffer(): ArrayBuffer {
  return new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").buffer;
}

function fbxBuffer(): ArrayBuffer {
  return buildFBXBinary({
    nodes: [
      objectsSection([objectNode("Model", 1n, "Cube", "Mesh"), geometryNode(2n, "G", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3])]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ],
  });
}

describe("detect -> load adapter -> normalize a real result, for every supported format", () => {
  it("STL", async () => {
    const buf = binaryStlBuffer();
    const detection = detectFormat(buf, "stl");
    expect(detection.format).toBe("stl");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = parseSTL(buf, DEFAULT_STL_LIMITS);
    expect(adapter.info(result).length).toBeGreaterThan(0);
    expect(adapter.fitAllTarget(result).radius).toBeGreaterThan(0);
  });

  it("OBJ", async () => {
    const buf = objBuffer();
    const detection = detectFormat(buf, "obj");
    expect(detection.format).toBe("obj");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = parseOBJForViewer(new TextDecoder().decode(buf));
    expect(adapter.segments(result)).not.toBeNull();
  });

  it("3MF", async () => {
    const buf = build3MFPackage(buildModelXML({ objects: [simpleTriangleMesh()], buildItems: [{ objectId: "1" }] }));
    const detection = detectFormat(buf, "3mf");
    expect(detection.format).toBe("3mf");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = resolveThreeMFViewerPackage(buf);
    expect(adapter.dimensions(result).width).toMatch(/mm$/);
  });

  it("GLB", async () => {
    const buf = simpleTriangleGLB();
    const detection = detectFormat(buf, "glb");
    expect(detection.format).toBe("glb");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = resolveGLBViewerPackage(buf);
    expect(adapter.segments(result)!.length).toBe(result.segments.length);
  });

  it("PLY", async () => {
    const buf = simpleTrianglePLY("ascii");
    const detection = detectFormat(buf, "ply");
    expect(detection.format).toBe("ply");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = resolvePLYViewerPackage(buf);
    expect(adapter.info(result).length).toBeGreaterThan(0);
  });

  it("binary FBX", async () => {
    const buf = fbxBuffer();
    const detection = detectFormat(buf, "fbx");
    expect(detection.format).toBe("fbx");
    const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
    const result = resolveFBXViewerScene(buf);
    expect(adapter.segments(result)!.length).toBe(result.segments.length);
  });
});

describe("sequential cross-format detection: STL -> GLB -> PLY -> FBX -> OBJ -> 3MF", () => {
  it("each step detects the correct format independent of what came before", async () => {
    const sequence: { name: string; buffer: ArrayBuffer; expected: string }[] = [
      { name: "a.stl", buffer: binaryStlBuffer(), expected: "stl" },
      { name: "b.glb", buffer: simpleTriangleGLB(), expected: "glb" },
      { name: "c.ply", buffer: simpleTrianglePLY("ascii"), expected: "ply" },
      { name: "d.fbx", buffer: fbxBuffer(), expected: "fbx" },
      { name: "e.obj", buffer: objBuffer(), expected: "obj" },
      { name: "f.3mf", buffer: build3MFPackage(buildModelXML({ objects: [simpleTriangleMesh()], buildItems: [{ objectId: "1" }] })), expected: "3mf" },
    ];

    const loadedAdapters: string[] = [];
    for (const step of sequence) {
      const ext = step.name.slice(step.name.lastIndexOf(".") + 1);
      const detection = detectFormat(step.buffer, ext);
      expect(detection.format).toBe(step.expected);
      const adapter = (await ADAPTER_LOADERS[detection.format!]()).default;
      expect(adapter.format).toBe(step.expected);
      loadedAdapters.push(adapter.format);
    }
    expect(loadedAdapters).toEqual(["stl", "glb", "ply", "fbx", "obj", "3mf"]);
  });
});
