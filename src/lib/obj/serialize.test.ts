import { describe, expect, it } from "vitest";
import { serializeOBJ } from "./serialize";
import { deduplicateVertices } from "./deduplicate";
import { parseOBJDocument } from "./parser";

const LIMITS = { maxFaces: 1_000_000, maxOutputBytes: 200 * 1024 * 1024 };
const DEDUP_LIMITS = { maxUniqueVertices: 1_000_000 };

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function buildTriangle() {
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = Float32Array.from([0, 0, 1]);
  const geometry = await deduplicateVertices(positions, DEDUP_LIMITS);
  return { geometry, normals };
}

describe("serializeOBJ — structure", () => {
  it("includes the fixed header comment and object name", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text.startsWith("# Generated locally by MeshKit\n")).toBe(true);
    expect(text).toContain("o MeshKit_Converted\n");
    expect(text).toContain("s off\n");
  });

  it("uses LF-only line endings", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text.includes("\r")).toBe(false);
  });

  it("ends with a trailing newline", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is valid UTF-8 text", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)).not.toThrow();
  });

  it("produces deterministic output for deterministic input", async () => {
    const { geometry, normals } = await buildTriangle();
    const a = await serializeOBJ(geometry, normals, LIMITS);
    const b = await serializeOBJ(geometry, normals, LIMITS);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("never includes an original filename or STL header text", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text).not.toContain("model.stl");
    expect(text).not.toContain("solid");
  });

  it("never emits mtllib, usemtl or texture coordinates", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text).not.toMatch(/^mtllib/m);
    expect(text).not.toMatch(/^usemtl/m);
    expect(text).not.toMatch(/^vt /m);
  });
});

describe("serializeOBJ — indices, normals, winding", () => {
  it("uses correct one-based v//vn indices", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    expect(text).toContain("f 1//1 2//1 3//1");
  });

  it("emits exactly one normal per face", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]);
    const normals = Float32Array.from([0, 0, 1, 0, 0, 1]);
    const geometry = await deduplicateVertices(positions, DEDUP_LIMITS);
    const result = await serializeOBJ(geometry, normals, LIMITS);
    expect(result.normalCount).toBe(2);
    const text = decode(result.bytes);
    expect((text.match(/^vn /gm) ?? []).length).toBe(2);
  });

  it("preserves triangle winding in face index order", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    // Source order was (0,0,0)->(1,0,0)->(0,1,0), which dedup assigns indices 0,1,2 in that order.
    expect(text).toContain("f 1//1 2//1 3//1");
  });

  it("parses successfully with the existing production OBJ parser", async () => {
    const { geometry, normals } = await buildTriangle();
    const result = await serializeOBJ(geometry, normals, LIMITS);
    const text = decode(result.bytes);
    const parsed = parseOBJDocument(text, {
      maxTextBytes: 1e9,
      maxVertexCount: 1e6,
      maxFaceVertexCount: 256,
      maxTriangles: 1e6,
      maxCoordinateMagnitude: 1e9,
      maxTriangulationIterations: 10000,
    });
    expect(parsed.sourceVertexCount).toBe(3);
    expect(parsed.triangles).toEqual([{ a: 0, b: 1, c: 2 }]);
  });
});

describe("serializeOBJ — limits and errors", () => {
  it("rejects when no output geometry exists", async () => {
    const geometry = { vertices: new Float32Array(0), triangleVertexIndices: new Uint32Array(0), sourceVertexCount: 0, uniqueVertexCount: 0 };
    await expect(serializeOBJ(geometry, new Float32Array(0), LIMITS)).rejects.toMatchObject({ code: "OBJ_NO_OUTPUT_GEOMETRY" });
  });

  it("enforces the face-count limit", async () => {
    const { geometry, normals } = await buildTriangle();
    await expect(serializeOBJ(geometry, normals, { ...LIMITS, maxFaces: 0 })).rejects.toMatchObject({ code: "OBJ_FACE_LIMIT_EXCEEDED" });
  });

  it("enforces the output byte-size ceiling before allocating a final buffer", async () => {
    const { geometry, normals } = await buildTriangle();
    await expect(serializeOBJ(geometry, normals, { ...LIMITS, maxOutputBytes: 10 })).rejects.toMatchObject({ code: "OBJ_OUTPUT_TOO_LARGE" });
  });

  it("supports cancellation during large-loop serialization", async () => {
    const n = 300_000;
    const positions = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const base = t * 9;
      positions[base] = t;
      positions[base + 3] = t + 1;
      positions[base + 7] = 1;
    }
    const geometry = await deduplicateVertices(positions, { maxUniqueVertices: 10_000_000 });
    const normals = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) normals[t * 3 + 2] = 1;

    let cancelled = false;
    const promise = serializeOBJ(geometry, normals, { maxFaces: 10_000_000, maxOutputBytes: 1024 * 1024 * 1024 }, {
      isCancelled: () => cancelled,
      yieldEvery: 1000,
    });
    cancelled = true;
    await expect(promise).rejects.toThrow("cancelled");
  });
});
