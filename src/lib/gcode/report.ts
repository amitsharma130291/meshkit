/**
 * Builds the downloadable JSON analysis report. Same safety posture as
 * every other MeshWrench tool's own report: a deliberate SUBSET of
 * `AnalyzeResult` — never the render buffers, never full raw comments,
 * never a local path or stack trace, and never the file's own G-code
 * text.
 */
import type { AnalyzeResult } from "./analyze";

export const GCODE_REPORT_SCHEMA_VERSION = "1.0.0";
export const GCODE_TOOL_VERSION = "1.0.0";

export interface DownloadableGCodeReport {
  schemaVersion: string;
  toolVersion: string;
  generatedAt: string;
  parserScope: string;
  file: { name: string; sizeBytes: number };
  status: AnalyzeResult["status"];
  dialect: AnalyzeResult["dialect"];
  layers: {
    count: number;
    detectionMode: AnalyzeResult["layerDetectionMode"];
    nonPlanarDetected: boolean;
    heightRange: AnalyzeResult["statistics"]["layerHeightRange"];
  };
  movement: {
    linearMoveCount: number;
    arcMoves: number;
    generatedSegments: number;
    extrusionMoves: number;
    travelMoves: number;
    retracts: number;
    totalExtrusionDistanceMm: number;
    totalTravelDistanceMm: number;
    totalZTravelMm: number;
    feedRateRange: AnalyzeResult["statistics"]["feedRateRange"];
  };
  tools: {
    count: number;
    ids: number[];
    rawEDeltaByTool: Record<number, number>;
    temperatureSetpoints: Record<number, number[]>;
    bedTemperatureSetpoints: number[];
    /** Range across the active nozzle temperature actually seen on rendered segments — never bed temperature. */
    temperatureRange: AnalyzeResult["statistics"]["temperatureRange"];
  };
  bounds: {
    motion: AnalyzeResult["statistics"]["motionBounds"];
    extrusion: AnalyzeResult["statistics"]["extrusionBounds"];
  };
  timeEstimates: {
    slicerProvidedSeconds: number | null;
    feedRateOnlySeconds: number;
    feedRateOnlySource: string;
  };
  parsing: {
    fileBytes: number;
    decodedLines: number;
    malformedLines: number;
    unknownCommandLines: number;
    unsupportedCommandSamples: string[];
    checksumValid: number;
    checksumMissing: number;
    checksumMismatched: number;
  };
  warnings: string[];
  safetyLimitStatus: "not-limited" | "limited";
  stoppedReason: string | null;
  limitations: string[];
}

const LIMITATIONS = [
  "This is a static, browser-based viewer/visualizer/simulator — it never connects to a printer, never uses WebSerial, and never executes any G-code or firmware macro.",
  "Playback is VISUAL ONLY. It never claims to exactly reproduce physical printer motion.",
  "The feed-rate-only time estimate divides path distance by commanded feed rate — it never models acceleration, jerk, junction deviation, pressure advance, firmware queues, bed leveling, or printer-specific macros. It is never the same as a slicer's own trusted estimate or actual print time.",
  "This tool targets a documented semantic subset of G-code aimed at common Marlin- and Klipper-style FDM output from Cura, PrusaSlicer, OrcaSlicer and Bambu Studio — not universal G-code support.",
  "Checksum validity says nothing about whether a file is safe to print — a mismatched or missing checksum is reported, never treated as a reason to hide an otherwise-inspectable file.",
];

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

export function buildDownloadableGCodeReport(result: AnalyzeResult, fileName: string, fileSizeBytes: number): DownloadableGCodeReport {
  return {
    schemaVersion: GCODE_REPORT_SCHEMA_VERSION,
    toolVersion: GCODE_TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    parserScope: "Common FDM slicer output (Marlin/Klipper-style) from Cura, PrusaSlicer, OrcaSlicer and Bambu Studio — a documented subset, not universal G-code support.",
    file: { name: sanitizeFileName(fileName), sizeBytes: fileSizeBytes },
    status: result.status,
    dialect: result.dialect,
    layers: {
      count: result.layers.length,
      detectionMode: result.layerDetectionMode,
      nonPlanarDetected: result.nonPlanarDetected,
      heightRange: result.statistics.layerHeightRange,
    },
    movement: {
      linearMoveCount: result.statistics.linearMoveCount,
      arcMoves: result.statistics.arcMoves,
      generatedSegments: result.statistics.generatedSegments,
      extrusionMoves: result.statistics.extrusionMoves,
      travelMoves: result.statistics.travelMoves,
      retracts: result.statistics.retracts,
      totalExtrusionDistanceMm: result.statistics.totalExtrusionDistance,
      totalTravelDistanceMm: result.statistics.totalTravelDistance,
      totalZTravelMm: result.statistics.totalZTravel,
      feedRateRange: result.statistics.feedRateRange,
    },
    tools: {
      count: result.statistics.tools.length,
      ids: result.statistics.tools,
      rawEDeltaByTool: result.statistics.rawEDeltaByTool,
      temperatureSetpoints: result.statistics.toolTemperatureSetpoints,
      bedTemperatureSetpoints: result.statistics.bedTemperatureSetpoints,
      temperatureRange: result.statistics.temperatureRange,
    },
    bounds: {
      motion: result.statistics.motionBounds,
      extrusion: result.statistics.extrusionBounds,
    },
    timeEstimates: {
      slicerProvidedSeconds: result.timing.slicerProvidedSeconds,
      feedRateOnlySeconds: result.timing.feedRateOnlySeconds,
      feedRateOnlySource: result.timing.feedRateOnlySource,
    },
    parsing: {
      fileBytes: result.statistics.fileBytes,
      decodedLines: result.statistics.decodedLines,
      malformedLines: result.statistics.malformedLines,
      unknownCommandLines: result.statistics.unknownCommandLines,
      unsupportedCommandSamples: result.unsupportedCommandSamples,
      checksumValid: result.statistics.checksumValid,
      checksumMissing: result.statistics.checksumMissing,
      checksumMismatched: result.statistics.checksumMismatched,
    },
    warnings: result.warnings,
    safetyLimitStatus: result.stoppedReason ? "limited" : "not-limited",
    stoppedReason: result.stoppedReason,
    limitations: LIMITATIONS,
  };
}
