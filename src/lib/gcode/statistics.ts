/**
 * Pure aggregation over an already-fully-processed file: the render
 * segments `analyze.ts` produced in its own single pass, plus the small
 * set of counters that pass cheaply accumulates along the way (line/
 * checksum/temperature/fan counts). Never re-walks raw G-code text —
 * every number here is derived only from data the pipeline already
 * computed once.
 */
import type { DetectedLayer } from "./layers";
import type { MoveSegment } from "./types";

export interface StatisticsInput {
  fileBytes: number;
  decodedLines: number;
  malformedLines: number;
  unknownCommandLines: number;
  checksumCounts: { valid: number; missing: number; mismatched: number };
  /** The number of actual G0/G1 source LINES — never derived from segment counts, since a linear move always contributes exactly one segment but an arc line can legitimately expand into many. */
  linearMoveLineCount: number;
  arcLineCount: number;
  layers: DetectedLayer[];
  toolTemperatureSetpoints: Record<number, number[]>;
  bedTemperatureSetpoints: number[];
  fanStateChanges: number;
  segments: MoveSegment[];
}

export interface Bounds3D {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface Range {
  min: number;
  max: number;
}

export interface GCodeStatistics {
  fileBytes: number;
  decodedLines: number;
  malformedLines: number;
  unknownCommandLines: number;
  checksumValid: number;
  checksumMissing: number;
  checksumMismatched: number;
  linearMoveCount: number;
  arcMoves: number;
  generatedSegments: number;
  extrusionMoves: number;
  travelMoves: number;
  retracts: number;
  primes: number;
  tools: number[];
  layerCount: number;
  layerHeightRange: Range | null;
  motionBounds: Bounds3D | null;
  extrusionBounds: Bounds3D | null;
  totalExtrusionDistance: number;
  totalTravelDistance: number;
  totalZTravel: number;
  feedRateRange: Range | null;
  /** Range across segments' own known active nozzle temperature — never bed temperature — `null` when no segment ever had one. */
  temperatureRange: Range | null;
  toolTemperatureSetpoints: Record<number, number[]>;
  bedTemperatureSetpoints: number[];
  fanStateChanges: number;
  rawEDeltaByTool: Record<number, number>;
}

function segmentDistance(s: MoveSegment): number {
  return Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z);
}

function extendBounds(bounds: Bounds3D | null, p: { x: number; y: number; z: number }): Bounds3D {
  if (!bounds) return { min: { ...p }, max: { ...p } };
  return {
    min: { x: Math.min(bounds.min.x, p.x), y: Math.min(bounds.min.y, p.y), z: Math.min(bounds.min.z, p.z) },
    max: { x: Math.max(bounds.max.x, p.x), y: Math.max(bounds.max.y, p.y), z: Math.max(bounds.max.z, p.z) },
  };
}

export function computeStatistics(input: StatisticsInput): GCodeStatistics {
  let motionBounds: Bounds3D | null = null;
  let extrusionBounds: Bounds3D | null = null;
  let totalExtrusionDistance = 0;
  let totalTravelDistance = 0;
  let totalZTravel = 0;
  let feedRateMin: number | null = null;
  let feedRateMax: number | null = null;
  let temperatureMin: number | null = null;
  let temperatureMax: number | null = null;
  let extrusionMoves = 0;
  let travelMoves = 0;
  let retracts = 0;
  let primes = 0;
  const tools = new Set<number>();
  const rawEDeltaByTool: Record<number, number> = {};

  for (const s of input.segments) {
    motionBounds = extendBounds(motionBounds, s.start);
    motionBounds = extendBounds(motionBounds, s.end);
    totalZTravel += Math.abs(s.end.z - s.start.z);

    if (s.category === "extrusion" || s.category === "e-only-extrusion") {
      extrusionMoves++;
      extrusionBounds = extendBounds(extrusionBounds, s.start);
      extrusionBounds = extendBounds(extrusionBounds, s.end);
      totalExtrusionDistance += segmentDistance(s);
    } else if (s.category === "travel" || s.category === "z-only") {
      travelMoves++;
      totalTravelDistance += segmentDistance(s);
    } else if (s.category === "retract" || s.category === "e-only-retract") {
      retracts++;
    }

    if (s.feedRate !== null) {
      feedRateMin = feedRateMin === null ? s.feedRate : Math.min(feedRateMin, s.feedRate);
      feedRateMax = feedRateMax === null ? s.feedRate : Math.max(feedRateMax, s.feedRate);
    }

    if (s.temperature !== null) {
      temperatureMin = temperatureMin === null ? s.temperature : Math.min(temperatureMin, s.temperature);
      temperatureMax = temperatureMax === null ? s.temperature : Math.max(temperatureMax, s.temperature);
    }

    tools.add(s.tool);
    rawEDeltaByTool[s.tool] = (rawEDeltaByTool[s.tool] ?? 0) + s.eDelta;
  }
  void primes; // reserved for a future sequence-aware prime count once analyze.ts threads `extrusion.ts` events through

  let layerHeightMin: number | null = null;
  let layerHeightMax: number | null = null;
  for (const layer of input.layers) {
    if (layer.height === null) continue;
    layerHeightMin = layerHeightMin === null ? layer.height : Math.min(layerHeightMin, layer.height);
    layerHeightMax = layerHeightMax === null ? layer.height : Math.max(layerHeightMax, layer.height);
  }

  return {
    fileBytes: input.fileBytes,
    decodedLines: input.decodedLines,
    malformedLines: input.malformedLines,
    unknownCommandLines: input.unknownCommandLines,
    checksumValid: input.checksumCounts.valid,
    checksumMissing: input.checksumCounts.missing,
    checksumMismatched: input.checksumCounts.mismatched,
    linearMoveCount: input.linearMoveLineCount,
    arcMoves: input.arcLineCount,
    generatedSegments: input.segments.length,
    extrusionMoves,
    travelMoves,
    retracts,
    primes,
    tools: Array.from(tools).sort((a, b) => a - b),
    layerCount: input.layers.length,
    layerHeightRange: layerHeightMin !== null && layerHeightMax !== null ? { min: layerHeightMin, max: layerHeightMax } : null,
    motionBounds,
    extrusionBounds,
    totalExtrusionDistance,
    totalTravelDistance,
    totalZTravel,
    feedRateRange: feedRateMin !== null && feedRateMax !== null ? { min: feedRateMin, max: feedRateMax } : null,
    temperatureRange: temperatureMin !== null && temperatureMax !== null ? { min: temperatureMin, max: temperatureMax } : null,
    toolTemperatureSetpoints: input.toolTemperatureSetpoints,
    bedTemperatureSetpoints: input.bedTemperatureSetpoints,
    fanStateChanges: input.fanStateChanges,
    rawEDeltaByTool,
  };
}
