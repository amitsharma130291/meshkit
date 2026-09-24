import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { detectFormat } from "./format-detection";
import { simpleTriangleGLB } from "../glb/test-fixtures";
import { build3MFPackage, buildModelXML, simpleTriangleMesh } from "../threemf/test-fixtures";
import { simpleTrianglePLY, pointCloudPLY, textToBuffer } from "../ply/test-fixtures";
import { buildAsciiFBX, buildFBXBinary } from "../fbx/test-fixtures";

function asciiStlBuffer(): ArrayBuffer {
  return textToBuffer("solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n");
}

function binaryStlBuffer(triangleCount: number): ArrayBuffer {
  const bytes = new Uint8Array(84 + triangleCount * 50);
  new DataView(bytes.buffer).setUint32(80, triangleCount, true);
  return bytes.buffer;
}

function objBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("detectFormat — GLB", () => {
  it("detects a valid GLB", () => {
    const result = detectFormat(simpleTriangleGLB(), "glb");
    expect(result.format).toBe("glb");
    expect(result.confidence).toBe("certain");
    expect(result.extensionMatches).toBe(true);
  });

  it("does not classify a truncated/impossible GLB header as GLB", () => {
    const buf = new ArrayBuffer(8); // shorter than the 12-byte header
    const result = detectFormat(buf, "glb");
    expect(result.format).not.toBe("glb");
  });

  it("rejects a GLB claiming a version other than 2", () => {
    const real = simpleTriangleGLB();
    const bytes = new Uint8Array(real.slice(0));
    new DataView(bytes.buffer).setUint32(4, 99, true);
    const result = detectFormat(bytes.buffer, "glb");
    expect(result.format).not.toBe("glb");
  });
});

describe("detectFormat — FBX", () => {
  it("detects binary FBX by its exact magic header", () => {
    const result = detectFormat(buildFBXBinary({ nodes: [{ name: "GlobalSettings" }] }), "fbx");
    expect(result.format).toBe("fbx");
    expect(result.confidence).toBe("certain");
  });

  it("detects and clearly flags an ASCII FBX file rather than misreading it", () => {
    const result = detectFormat(buildAsciiFBX(), "fbx");
    expect(result.format).toBe("fbx");
    expect(result.reason).toMatch(/ASCII FBX/i);
  });
});

describe("detectFormat — PLY", () => {
  it("detects an ASCII PLY file", () => {
    const result = detectFormat(simpleTrianglePLY("ascii"), "ply");
    expect(result.format).toBe("ply");
    expect(result.confidence).toBe("certain");
  });

  it("detects a binary little-endian PLY file", () => {
    const result = detectFormat(simpleTrianglePLY("binary_little_endian"), "ply");
    expect(result.format).toBe("ply");
  });

  it("detects a binary big-endian PLY file", () => {
    const result = detectFormat(simpleTrianglePLY("binary_big_endian"), "ply");
    expect(result.format).toBe("ply");
  });

  it("detects a point-cloud-only PLY file", () => {
    const result = detectFormat(pointCloudPLY("ascii"), "ply");
    expect(result.format).toBe("ply");
  });

  it("does not confidently detect a PLY file preceded by a UTF-8 BOM, matching the production parser's own strictness", () => {
    const real = simpleTrianglePLY("ascii");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const combined = new Uint8Array(bom.length + real.byteLength);
    combined.set(bom, 0);
    combined.set(new Uint8Array(real), bom.length);
    const result = detectFormat(combined.buffer, "ply");
    expect(result.format).not.toBe("ply");
  });
});

describe("detectFormat — 3MF vs generic ZIP", () => {
  it("detects a valid 3MF package", () => {
    const pkg = build3MFPackage(buildModelXML({ objects: [simpleTriangleMesh()], buildItems: [{ objectId: "1" }] }));
    const result = detectFormat(pkg, "3mf");
    expect(result.format).toBe("3mf");
    expect(result.confidence).toBe("certain");
  });

  it("rejects a generic ZIP archive with no 3MF structure, never dispatching it as 3MF", () => {
    const zip = zipSync({ "readme.txt": new TextEncoder().encode("just a regular zip file") });
    const result = detectFormat(zip.buffer, null);
    expect(result.format).toBeNull();
  });

  it("rejects a .3mf-named file that's actually just a generic ZIP", () => {
    const zip = zipSync({ "hello.txt": new TextEncoder().encode("not a 3mf package") });
    const result = detectFormat(zip.buffer, "3mf");
    expect(result.format).toBeNull();
    expect(result.extensionMatches).toBeNull(); // format is null, nothing to compare
  });
});

describe("detectFormat — STL", () => {
  it("detects binary STL via the exact 84 + triangleCount*50 length formula", () => {
    const result = detectFormat(binaryStlBuffer(10), "stl");
    expect(result.format).toBe("stl");
    expect(result.confidence).toBe("certain");
  });

  it("does not classify arbitrary binary data >= 84 bytes as STL", () => {
    const bytes = new Uint8Array(200);
    bytes.fill(0x42);
    // Declared triangle count deliberately does NOT match the actual length.
    new DataView(bytes.buffer).setUint32(80, 999, true);
    const result = detectFormat(bytes.buffer, "stl");
    expect(result.format).not.toBe("stl");
  });

  it("uses overflow-safe arithmetic for a very large declared triangle count", () => {
    const bytes = new Uint8Array(84);
    new DataView(bytes.buffer).setUint32(80, 0xffffffff, true); // max uint32
    const result = detectFormat(bytes.buffer, "stl");
    // 84 + 4294967295*50 is a huge, exact, finite JS number — no overflow/wraparound — and clearly doesn't equal the actual 84-byte length.
    expect(result.format).not.toBe("stl");
  });

  it("detects ASCII STL", () => {
    const result = detectFormat(asciiStlBuffer(), "stl");
    expect(result.format).toBe("stl");
    expect(result.confidence).toBe("strong");
  });
});

describe("detectFormat — OBJ", () => {
  it("detects OBJ text with leading blank lines and comments", () => {
    const text = "\n\n# a comment\n\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const result = detectFormat(objBuffer(text), "obj");
    expect(result.format).toBe("obj");
    expect(result.confidence).toBe("strong");
  });

  it("detects OBJ via mtllib/usemtl/vn/vt records", () => {
    const text = "mtllib scene.mtl\nusemtl Red\nv 0 0 0\nvn 0 0 1\nvt 0 0\nf 1 1 1\n";
    const result = detectFormat(objBuffer(text), "obj");
    expect(result.format).toBe("obj");
  });

  it("handles a UTF-8 BOM before OBJ content", () => {
    const bom = "﻿";
    const text = `${bom}v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`;
    const result = detectFormat(objBuffer(text), "obj");
    expect(result.format).toBe("obj");
  });

  it("does not classify arbitrary prose as OBJ merely because a line happens to start with a recognized letter", () => {
    const text = "So this is a story about geometry.\nA face has three vertices.\nLines can be drawn between them.\n";
    const result = detectFormat(objBuffer(text), "obj");
    expect(result.format).not.toBe("obj");
  });
});

describe("detectFormat — ambiguity and unknown content", () => {
  it("returns a null format with 'none' confidence for genuinely unrecognizable binary data", () => {
    const bytes = new Uint8Array(500);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    const result = detectFormat(bytes.buffer, null);
    expect(result.format).toBeNull();
    expect(result.confidence).toBe("none");
  });

  it("returns a null format for an empty file", () => {
    const result = detectFormat(new ArrayBuffer(0), "stl");
    expect(result.format).toBeNull();
  });

  it("never throws on malformed content it can't classify", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // ZIP magic, then garbage — too short for a real ZIP
    expect(() => detectFormat(bytes.buffer, "3mf")).not.toThrow();
  });
});

describe("detectFormat — extension handling", () => {
  it("flags a mismatch when the extension disagrees with confidently detected content (OBJ text named .stl)", () => {
    const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const result = detectFormat(objBuffer(text), "stl");
    expect(result.format).toBe("obj");
    expect(result.extensionMatches).toBe(false);
  });

  it("detects GLB content regardless of a misleading .obj extension", () => {
    const result = detectFormat(simpleTriangleGLB(), "obj");
    expect(result.format).toBe("glb");
    expect(result.extensionMatches).toBe(false);
  });

  it("reports extensionMatches as null when there is no extension at all", () => {
    const result = detectFormat(simpleTriangleGLB(), null);
    expect(result.extensionMatches).toBeNull();
  });

  it("reports extensionMatches as null for an unrecognized extension", () => {
    const result = detectFormat(simpleTriangleGLB(), "xyz");
    expect(result.extensionMatches).toBeNull();
  });

  it("normalizes an uppercase extension before comparing", () => {
    const result = detectFormat(simpleTriangleGLB(), "GLB");
    expect(result.extensionMatches).toBe(true);
  });

  it("treats a leading-dot extension the same as a bare one", () => {
    const result = detectFormat(simpleTriangleGLB(), ".glb");
    expect(result.extensionMatches).toBe(true);
  });
});

describe("detectFormat — never parses an unbounded prefix", () => {
  it("only reads a bounded prefix even for a very large text file", () => {
    const hugeText = "# padding\n".repeat(2_000_000) + "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const start = Date.now();
    const result = detectFormat(objBuffer(hugeText), "obj");
    const elapsedMs = Date.now() - start;
    // The real OBJ content is far past the bounded prefix, so it must NOT be found — proving detection didn't scan the whole file.
    expect(result.format).not.toBe("obj");
    expect(elapsedMs).toBeLessThan(500);
  });
});
