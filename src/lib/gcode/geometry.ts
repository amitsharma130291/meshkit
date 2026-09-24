/**
 * Packs `MoveSegment[]` into transferable typed arrays for Three.js line
 * rendering. Layer filtering never duplicates the position buffer — it
 * reads a precomputed, contiguous per-layer segment RANGE (segments are
 * always produced in sequential file order, so each layer's segments are
 * already contiguous) and uses that as a WebGL `drawRange`, exactly the
 * same "range, not a copy" approach `mesh-optimization/`'s own render
 * buffers use. A file large enough to exceed `maxSegmentsPerChunk` is
 * split into multiple independently-renderable chunks (each its own set
 * of typed arrays) rather than growing one unbounded buffer.
 */
import { computeSegmentDurationSeconds } from "./timing";
import type { MoveCategory } from "./linear-moves";
import type { FeatureCategory } from "./features";
import type { MoveSegment } from "./types";

export const MOVE_CATEGORY_CODES: Record<MoveCategory, number> = {
  extrusion: 0,
  travel: 1,
  retract: 2,
  "e-only-extrusion": 3,
  "e-only-retract": 4,
  "z-only": 5,
  "zero-length-state-update": 6,
};

export const FEATURE_CATEGORY_CODES: Record<FeatureCategory, number> = {
  "outer-wall": 0,
  "inner-wall": 1,
  infill: 2,
  "solid-infill": 3,
  "top-surface": 4,
  "bottom-surface": 5,
  support: 6,
  "support-interface": 7,
  bridge: 8,
  skirt: 9,
  brim: 10,
  raft: 11,
  purge: 12,
  "prime-tower": 13,
  custom: 14,
  "unknown-extrusion": 15,
  travel: 16,
};

export interface RenderBufferLimits {
  maxSegmentsPerChunk: number;
  /** Beyond this many TOTAL segments, `sourceLineIndices` is omitted entirely (not per-chunk) to bound memory on very large files. */
  maxSourceLineIndexTracking: number;
}

export const DEFAULT_RENDER_BUFFER_LIMITS: RenderBufferLimits = {
  maxSegmentsPerChunk: 200_000,
  maxSourceLineIndexTracking: 2_000_000,
};

export interface RenderChunk {
  positions: Float32Array;
  categoryCodes: Uint8Array;
  featureCodes: Uint8Array;
  toolIndices: Uint16Array;
  /** NaN sentinel for "no feed rate known" — never a false zero. */
  feedRates: Float32Array;
  eDeltas: Float32Array;
  /** -1 sentinel for "no layer known". */
  layerIndices: Int32Array;
  /** NaN sentinel for "no active nozzle temperature known" — never a false zero. */
  temperatures: Float32Array;
  cumulativeTimeSeconds: Float32Array;
  sourceLineIndices: Int32Array | null;
  segmentCount: number;
}

export interface LayerRange {
  layerIndex: number;
  chunkIndex: number;
  startSegment: number;
  endSegment: number;
}

export interface RenderBuffers {
  chunks: RenderChunk[];
  layerRanges: LayerRange[];
  totalSegments: number;
}

/** Global (whole-file) contiguous layer run, before it's split at chunk boundaries. */
interface GlobalLayerRun {
  layerIndex: number;
  start: number;
  end: number;
}

function computeGlobalLayerRuns(segments: readonly MoveSegment[]): GlobalLayerRun[] {
  const runs: GlobalLayerRun[] = [];
  for (let i = 0; i < segments.length; i++) {
    const layerIndex = segments[i].layerIndex;
    if (layerIndex === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.layerIndex === layerIndex && last.end === i) {
      last.end = i + 1;
    } else {
      runs.push({ layerIndex, start: i, end: i + 1 });
    }
  }
  return runs;
}

/** Splits global (whole-file) layer runs at chunk boundaries, converting each piece into a chunk-local range. */
function splitRunsByChunk(runs: readonly GlobalLayerRun[], maxSegmentsPerChunk: number): LayerRange[] {
  const ranges: LayerRange[] = [];
  for (const run of runs) {
    let pos = run.start;
    while (pos < run.end) {
      const chunkIndex = Math.floor(pos / maxSegmentsPerChunk);
      const chunkStart = chunkIndex * maxSegmentsPerChunk;
      const chunkEnd = chunkStart + maxSegmentsPerChunk;
      const pieceEnd = Math.min(run.end, chunkEnd);
      ranges.push({ layerIndex: run.layerIndex, chunkIndex, startSegment: pos - chunkStart, endSegment: pieceEnd - chunkStart });
      pos = pieceEnd;
    }
  }
  return ranges;
}

export function packRenderBuffers(segments: readonly MoveSegment[], limits: RenderBufferLimits = DEFAULT_RENDER_BUFFER_LIMITS): RenderBuffers {
  const totalSegments = segments.length;
  if (totalSegments === 0) return { chunks: [], layerRanges: [], totalSegments: 0 };

  const includeSourceLines = totalSegments <= limits.maxSourceLineIndexTracking;
  const chunks: RenderChunk[] = [];
  let cumulativeTime = 0;

  for (let chunkStart = 0; chunkStart < totalSegments; chunkStart += limits.maxSegmentsPerChunk) {
    const chunkEnd = Math.min(chunkStart + limits.maxSegmentsPerChunk, totalSegments);
    const count = chunkEnd - chunkStart;

    const positions = new Float32Array(count * 6);
    const categoryCodes = new Uint8Array(count);
    const featureCodes = new Uint8Array(count);
    const toolIndices = new Uint16Array(count);
    const feedRates = new Float32Array(count);
    const eDeltas = new Float32Array(count);
    const layerIndices = new Int32Array(count);
    const temperatures = new Float32Array(count);
    const cumulativeTimeSeconds = new Float32Array(count);
    const sourceLineIndices = includeSourceLines ? new Int32Array(count) : null;

    for (let i = 0; i < count; i++) {
      const s = segments[chunkStart + i];
      const base = i * 6;
      positions[base] = s.start.x;
      positions[base + 1] = s.start.y;
      positions[base + 2] = s.start.z;
      positions[base + 3] = s.end.x;
      positions[base + 4] = s.end.y;
      positions[base + 5] = s.end.z;

      categoryCodes[i] = MOVE_CATEGORY_CODES[s.category];
      featureCodes[i] = FEATURE_CATEGORY_CODES[s.feature];
      toolIndices[i] = s.tool;
      feedRates[i] = s.feedRate === null ? NaN : s.feedRate;
      eDeltas[i] = s.eDelta;
      layerIndices[i] = s.layerIndex === null ? -1 : s.layerIndex;
      temperatures[i] = s.temperature === null ? NaN : s.temperature;

      cumulativeTime += computeSegmentDurationSeconds(s);
      cumulativeTimeSeconds[i] = cumulativeTime;

      if (sourceLineIndices) sourceLineIndices[i] = s.sourceLineIndex;
    }

    chunks.push({ positions, categoryCodes, featureCodes, toolIndices, feedRates, eDeltas, layerIndices, temperatures, cumulativeTimeSeconds, sourceLineIndices, segmentCount: count });
  }

  const layerRanges = splitRunsByChunk(computeGlobalLayerRuns(segments), limits.maxSegmentsPerChunk);

  return { chunks, layerRanges, totalSegments };
}
