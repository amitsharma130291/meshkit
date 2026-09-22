/**
 * Exact vertex deduplication for any indexed-mesh output format. STL
 * stores every triangle's three vertices independently (the same
 * position commonly repeats many times across adjacent triangles); both
 * OBJ and 3MF can reference one vertex record from multiple faces. This
 * module ONLY merges vertices whose coordinates are bit-for-bit
 * identical — no distance tolerance, no seam welding, no topology
 * reconstruction. That's a deliberate scope boundary shared by every
 * converter that uses it: welding "close enough" vertices is a
 * mesh-repair operation, never a format-conversion one.
 *
 * Canonical, format-neutral home for this logic — moved here from
 * `src/lib/obj/` (where it originated during the OBJ writer's Phase 3D
 * implementation) once the 3MF writer (Phase 3E) needed the identical
 * indexing behavior for the same `Float32Array` geometry.
 * `src/lib/obj/deduplicate.ts` now re-exports a thin, behavior-preserving
 * wrapper around this module.
 */
import { NonFiniteCoordinateError, UniqueVertexLimitExceededError } from "./errors";
import { yieldIfCancelled } from "../cancellation";

export interface DeduplicatedGeometry {
  /** Flat [x,y,z, x,y,z, ...], one entry per UNIQUE vertex, in first-occurrence order. */
  vertices: Float32Array;
  /** One (0-based, into `vertices`) index per ORIGINAL triangle-vertex slot — read three at a time to get one triangle's corners. */
  triangleVertexIndices: Uint32Array;
  sourceVertexCount: number;
  uniqueVertexCount: number;
}

export interface DeduplicateLimits {
  maxUniqueVertices: number;
}

export interface DeduplicateOptions {
  isCancelled?: () => boolean;
  /** How many source vertices to process between cancellation checks. Tuned so ordinary-sized meshes never yield at all. */
  yieldEvery?: number;
}

const DEFAULT_YIELD_EVERY = 100_000;

/** Bit-pattern scratch buffer, reused across calls — avoids allocating a new DataView per vertex component. */
const bitView = new DataView(new ArrayBuffer(4));

/**
 * A float32's raw bit pattern, used as the deduplication key instead of a
 * decimal string — sidesteps any ambiguity from how a number formats
 * (e.g. "1" vs "1.0" would be the same key either way, but a string key
 * built carelessly could accidentally collide or fail to collide based on
 * formatting choices; bit patterns can't). `-0`'s bit pattern is
 * normalized to `+0`'s before keying, so `-0` and `0` are treated as the
 * same vertex position — tested explicitly.
 */
function float32Bits(value: number): number {
  bitView.setFloat32(0, value === 0 ? 0 : value, true);
  return bitView.getInt32(0, true);
}

/**
 * Deduplicates a flat, non-indexed position buffer (9 floats per
 * triangle, STL's own layout) into unique vertices + per-corner indices.
 * Uses a `Map` (amortized O(1) lookup/insert) rather than any per-vertex
 * linear scan, so this stays linear in vertex count regardless of mesh
 * size.
 */
export async function deduplicateVertices(
  positions: Float32Array,
  limits: DeduplicateLimits,
  options: DeduplicateOptions = {},
): Promise<DeduplicatedGeometry> {
  const sourceVertexCount = positions.length / 3;
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;

  const keyToIndex = new Map<string, number>();
  const triangleVertexIndices = new Uint32Array(sourceVertexCount);
  const uniqueValues: number[] = [];

  for (let i = 0; i < sourceVertexCount; i++) {
    await yieldIfCancelled(i, yieldEvery, options.isCancelled);

    const base = i * 3;
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      // Defense in depth: every parser upstream already rejects
      // non-finite vertices on input.
      throw new NonFiniteCoordinateError();
    }

    const key = `${float32Bits(x)}_${float32Bits(y)}_${float32Bits(z)}`;
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = keyToIndex.size;
      if (index >= limits.maxUniqueVertices) {
        throw new UniqueVertexLimitExceededError();
      }
      keyToIndex.set(key, index);
      uniqueValues.push(x, y, z);
    }
    triangleVertexIndices[i] = index;
  }

  return {
    vertices: Float32Array.from(uniqueValues),
    triangleVertexIndices,
    sourceVertexCount,
    uniqueVertexCount: keyToIndex.size,
  };
}
