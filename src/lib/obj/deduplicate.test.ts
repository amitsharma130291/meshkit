import { describe, expect, it } from "vitest";
import { deduplicateVertices } from "./deduplicate";

const LIMITS = { maxUniqueVertices: 1_000_000 };

describe("deduplicateVertices", () => {
  it("keeps a single triangle's three distinct vertices", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(3);
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 2]);
  });

  it("deduplicates a shared edge between two triangles", async () => {
    // Triangle A: (0,0,0)(1,0,0)(0,1,0); Triangle B shares the edge (1,0,0)-(0,1,0).
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(4);
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 2, 1, 2, 3]);
  });

  it("deduplicates a single shared vertex referenced by many triangles", async () => {
    // A fan of 5 triangles sharing one apex at the origin, each spanning
    // [i,1,0]-[i+1,1,0] along the opposite edge — consecutive triangles
    // also share an edge vertex with each other (triangle i's "i+1"
    // corner equals triangle i+1's "i" corner).
    const shared: number[] = [0, 0, 0];
    const positions: number[] = [];
    for (let i = 0; i < 5; i++) positions.push(...shared, i, 1, 0, i + 1, 1, 0);
    const result = await deduplicateVertices(Float32Array.from(positions), LIMITS);
    // 5 triangles * 3 verts = 15 source slots; the shared apex collapses
    // to 1 vertex, and the fan's outer edge collapses to the 6 distinct
    // values {0,1,2,3,4,5} along y=1 — 7 unique vertices total.
    expect(result.sourceVertexCount).toBe(15);
    expect(result.uniqueVertexCount).toBe(7);
  });

  it("deduplicates fully duplicate triangles down to 3 unique vertices", async () => {
    const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const positions = Float32Array.from([...triangle, ...triangle, ...triangle]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(3);
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });

  it("treats positive and negative zero as the same vertex", async () => {
    const positions = Float32Array.from([-0, 0, -0, 0, 0, 0, 1, 1, 1]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(2);
    expect(result.triangleVertexIndices[0]).toBe(result.triangleVertexIndices[1]);
  });

  it("keeps close-but-not-identical vertices distinct (no tolerance welding)", async () => {
    const positions = Float32Array.from([0, 0, 0, 0.0000001, 0, 0, 1, 1, 1]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(3);
  });

  it("assigns indices in deterministic first-occurrence order", async () => {
    const positions = Float32Array.from([5, 5, 5, 1, 1, 1, 5, 5, 5, 2, 2, 2]);
    const result = await deduplicateVertices(positions, LIMITS);
    // (5,5,5) seen first -> index 0; (1,1,1) second -> index 1; repeat of (5,5,5) -> index 0; (2,2,2) -> index 2.
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 0, 2]);
    expect(Array.from(result.vertices)).toEqual([5, 5, 5, 1, 1, 1, 2, 2, 2]);
  });

  it("handles a large generated mesh without a quadratic blowup (completes quickly)", async () => {
    const n = 20_000;
    const positions = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const base = t * 9;
      positions[base] = t;
      positions[base + 1] = 0;
      positions[base + 2] = 0;
      positions[base + 3] = t + 1;
      positions[base + 4] = 0;
      positions[base + 5] = 0;
      positions[base + 6] = t;
      positions[base + 7] = 1;
      positions[base + 8] = 0;
    }
    const start = Date.now();
    const result = await deduplicateVertices(positions, LIMITS);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.sourceVertexCount).toBe(n * 3);
  });

  it("enforces the unique-vertex limit", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    await expect(deduplicateVertices(positions, { maxUniqueVertices: 2 })).rejects.toMatchObject({ code: "OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED" });
  });

  it("rejects a non-finite coordinate defensively", async () => {
    const positions = Float32Array.from([0, 0, 0, Number.NaN, 0, 0, 1, 1, 1]);
    await expectAsyncOBJError(() => deduplicateVertices(positions, LIMITS), "OBJ_NON_FINITE_OUTPUT");
  });

  it("respects cancellation during a large deduplication loop", async () => {
    const n = 500_000;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = i;
    let cancelled = false;
    const promise = deduplicateVertices(positions, LIMITS, { isCancelled: () => cancelled, yieldEvery: 1000 });
    cancelled = true;
    await expect(promise).rejects.toThrow("cancelled");
  });
});

async function expectAsyncOBJError(fn: () => Promise<unknown>, code: string): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ code });
}
