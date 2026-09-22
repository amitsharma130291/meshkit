import { describe, expect, it } from "vitest";
import { deduplicateVertices } from "./deduplicate";
import { NonFiniteCoordinateError, UniqueVertexLimitExceededError } from "./errors";

const LIMITS = { maxUniqueVertices: 1_000_000 };

describe("deduplicateVertices (canonical, format-neutral)", () => {
  it("keeps a single triangle's three distinct vertices", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(3);
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 2]);
  });

  it("deduplicates a shared edge between two triangles", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const result = await deduplicateVertices(positions, LIMITS);
    expect(result.uniqueVertexCount).toBe(4);
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 2, 1, 2, 3]);
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
    expect(Array.from(result.triangleVertexIndices)).toEqual([0, 1, 0, 2]);
    expect(Array.from(result.vertices)).toEqual([5, 5, 5, 1, 1, 1, 2, 2, 2]);
  });

  it("throws the generic UniqueVertexLimitExceededError, not a domain-specific one", async () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    await expect(deduplicateVertices(positions, { maxUniqueVertices: 2 })).rejects.toBeInstanceOf(UniqueVertexLimitExceededError);
  });

  it("throws the generic NonFiniteCoordinateError, not a domain-specific one", async () => {
    const positions = Float32Array.from([0, 0, 0, Number.NaN, 0, 0, 1, 1, 1]);
    await expect(deduplicateVertices(positions, LIMITS)).rejects.toBeInstanceOf(NonFiniteCoordinateError);
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
