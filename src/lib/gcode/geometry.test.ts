import { describe, expect, it } from "vitest";
import { packRenderBuffers, DEFAULT_RENDER_BUFFER_LIMITS, MOVE_CATEGORY_CODES, FEATURE_CATEGORY_CODES } from "./geometry";
import type { MoveSegment } from "./types";

function seg(overrides: Partial<MoveSegment> = {}): MoveSegment {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 1, y: 0, z: 0 },
    category: "extrusion",
    feature: "outer-wall",
    tool: 0,
    feedRate: 1500,
    eDelta: 0.1,
    rapid: false,
    volumetric: false,
    layerIndex: 0,
    sourceLineIndex: 0,
    temperature: null,
    ...overrides,
  };
}

describe("packRenderBuffers — basic packing", () => {
  it("packs each segment's start/end into a flat positions array (6 floats per segment)", () => {
    const result = packRenderBuffers([seg({ start: { x: 1, y: 2, z: 3 }, end: { x: 4, y: 5, z: 6 } })]);
    expect(result.totalSegments).toBe(1);
    expect(Array.from(result.chunks[0].positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("packs category and feature codes using the exported code maps", () => {
    const result = packRenderBuffers([seg({ category: "travel", feature: "skirt" })]);
    expect(result.chunks[0].categoryCodes[0]).toBe(MOVE_CATEGORY_CODES.travel);
    expect(result.chunks[0].featureCodes[0]).toBe(FEATURE_CATEGORY_CODES.skirt);
  });

  it("packs tool index, feed rate and E delta per segment", () => {
    const result = packRenderBuffers([seg({ tool: 2, feedRate: 2400, eDelta: 0.05 })]);
    expect(result.chunks[0].toolIndices[0]).toBe(2);
    expect(result.chunks[0].feedRates[0]).toBeCloseTo(2400, 3);
    expect(result.chunks[0].eDeltas[0]).toBeCloseTo(0.05, 6);
  });

  it("packs a NaN sentinel for a null feed rate, never a false zero", () => {
    const result = packRenderBuffers([seg({ feedRate: null })]);
    expect(Number.isNaN(result.chunks[0].feedRates[0])).toBe(true);
  });

  it("packs each segment's own active temperature, with a NaN sentinel for unknown — never a false zero", () => {
    const result = packRenderBuffers([seg({ temperature: 205 }), seg({ temperature: null })]);
    expect(result.chunks[0].temperatures[0]).toBe(205);
    expect(Number.isNaN(result.chunks[0].temperatures[1])).toBe(true);
  });

  it("packs a -1 sentinel for a null layer index", () => {
    const result = packRenderBuffers([seg({ layerIndex: null })]);
    expect(result.chunks[0].layerIndices[0]).toBe(-1);
  });
});

describe("packRenderBuffers — cumulative feed-rate-only time", () => {
  it("accumulates each segment's own duration into a running total", () => {
    // 60mm at 60mm/min = 60s per segment.
    const segments = [seg({ end: { x: 60, y: 0, z: 0 }, feedRate: 60 }), seg({ start: { x: 60, y: 0, z: 0 }, end: { x: 120, y: 0, z: 0 }, feedRate: 60 })];
    const result = packRenderBuffers(segments);
    expect(result.chunks[0].cumulativeTimeSeconds[0]).toBeCloseTo(60, 3);
    expect(result.chunks[0].cumulativeTimeSeconds[1]).toBeCloseTo(120, 3);
  });
});

describe("packRenderBuffers — temperature attribute is a bounded, transferable typed array", () => {
  it("temperatures array length always equals segmentCount, consistent with every other per-segment attribute", () => {
    const segments = [seg({ temperature: 200 }), seg({ temperature: null }), seg({ temperature: 210 })];
    const result = packRenderBuffers(segments);
    const chunk = result.chunks[0];
    expect(chunk.temperatures.length).toBe(chunk.segmentCount);
    expect(chunk.temperatures).toBeInstanceOf(Float32Array);
    expect(chunk.temperatures.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe("packRenderBuffers — per-layer ranges without duplicating position data", () => {
  it("precomputes contiguous per-layer segment ranges", () => {
    const segments = [seg({ layerIndex: 0 }), seg({ layerIndex: 0 }), seg({ layerIndex: 1 }), seg({ layerIndex: 1 }), seg({ layerIndex: 1 })];
    const result = packRenderBuffers(segments);
    expect(result.layerRanges).toEqual([
      { layerIndex: 0, chunkIndex: 0, startSegment: 0, endSegment: 2 },
      { layerIndex: 1, chunkIndex: 0, startSegment: 2, endSegment: 5 },
    ]);
  });

  it("never allocates a second positions buffer per layer — layer filtering is range-based", () => {
    const segments = [seg({ layerIndex: 0 }), seg({ layerIndex: 1 })];
    const result = packRenderBuffers(segments);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].positions.length).toBe(segments.length * 6);
  });
});

describe("packRenderBuffers — chunking for very large files", () => {
  it("splits into multiple chunks when segment count exceeds the configured ceiling", () => {
    const segments = Array.from({ length: 10 }, () => seg());
    const result = packRenderBuffers(segments, { ...DEFAULT_RENDER_BUFFER_LIMITS, maxSegmentsPerChunk: 4 });
    expect(result.chunks.length).toBe(3); // 4 + 4 + 2
    expect(result.chunks[0].segmentCount).toBe(4);
    expect(result.chunks[2].segmentCount).toBe(2);
    expect(result.totalSegments).toBe(10);
  });

  it("layer ranges correctly reference the chunk they fall into when a layer spans a chunk boundary is avoided by chunk-local indices", () => {
    const segments = Array.from({ length: 6 }, (_, i) => seg({ layerIndex: i < 4 ? 0 : 1 }));
    const result = packRenderBuffers(segments, { ...DEFAULT_RENDER_BUFFER_LIMITS, maxSegmentsPerChunk: 4 });
    expect(result.chunks.length).toBe(2);
    // layer 0 fully in chunk 0, layer 1 fully in chunk 1 (0-2 local range)
    expect(result.layerRanges).toEqual([
      { layerIndex: 0, chunkIndex: 0, startSegment: 0, endSegment: 4 },
      { layerIndex: 1, chunkIndex: 1, startSegment: 0, endSegment: 2 },
    ]);
  });
});

describe("packRenderBuffers — source line index (bounded)", () => {
  it("includes sourceLineIndices when segment count is within the tracking limit", () => {
    const result = packRenderBuffers([seg({ sourceLineIndex: 42 })]);
    expect(result.chunks[0].sourceLineIndices).not.toBeNull();
    expect(result.chunks[0].sourceLineIndices![0]).toBe(42);
  });

  it("omits sourceLineIndices entirely once segment count exceeds the tracking ceiling, to bound memory", () => {
    const segments = Array.from({ length: 5 }, () => seg());
    const result = packRenderBuffers(segments, { ...DEFAULT_RENDER_BUFFER_LIMITS, maxSourceLineIndexTracking: 3 });
    expect(result.chunks[0].sourceLineIndices).toBeNull();
  });
});

describe("packRenderBuffers — empty input", () => {
  it("never crashes on zero segments", () => {
    const result = packRenderBuffers([]);
    expect(result.totalSegments).toBe(0);
    expect(result.chunks).toEqual([]);
    expect(result.layerRanges).toEqual([]);
  });
});
