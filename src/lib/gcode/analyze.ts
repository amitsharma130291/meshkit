/**
 * The main G-code analysis pipeline: decodes chunks → tokenizes each
 * line → resolves modal state, linear moves and arcs → tracks
 * layers/features/comments/checksums/dwell — all in ONE sequential pass
 * over the file, so nothing is re-parsed. Layer detection itself still
 * needs the whole file's events (per `layers.ts`'s own contract), so a
 * SECOND, cheap O(n) pass assigns each already-computed segment's
 * `layerIndex` from the layer boundaries — never a second parse of the
 * raw text.
 *
 * Never executes a macro or firmware-specific command — this module
 * only ever READS state to decide how to draw a path; nothing here can
 * affect a real printer.
 */
import { yieldIfCancelled } from "../cancellation";
import { ChunkedLineDecoder } from "./chunked-lines";
import { tokenizeLine } from "./tokenizer";
import { verifyChecksum } from "./checksum";
import { createInitialModalState, applyModalCommand, type ModalState } from "./modal-state";
import { applyLinearMove, type MoveCategory } from "./linear-moves";
import { applyArcMove, DEFAULT_ARC_LIMITS } from "./arcs";
import { parseSlicerComment, type SlicerCommentSignal } from "./comments";
import { inferDialect, type DialectInference } from "./dialect";
import { detectLayers, type DetectedLayer, type LayerDetectionMode, type LayerLineEvent } from "./layers";
import { classifyFeatureLabel } from "./features";
import { computeStatistics, type GCodeStatistics } from "./statistics";
import { buildTimingEstimate, parseDwellSeconds, type TimingEstimate } from "./timing";
import { packRenderBuffers, DEFAULT_RENDER_BUFFER_LIMITS, type RenderBuffers } from "./geometry";
import { gcodeError } from "./errors";
import type { GCodeResultStatus, MoveSegment } from "./types";

const KNOWN_MOTION_G_CODES = new Set([0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 90, 91, 92]);
const YIELD_EVERY_CHUNKS = 50;

export interface AnalyzeLimits {
  maxFileBytes: number;
  maxDecodedLines: number;
  maxLineLength: number;
  maxCommentLength: number;
  maxMalformedLineWarnings: number;
  maxUnsupportedCommandSamples: number;
  maxArcSubdivisionsPerArc: number;
  strictChecksums: boolean;
}

export const DEFAULT_ANALYZE_LIMITS: AnalyzeLimits = {
  maxFileBytes: 400 * 1024 * 1024,
  maxDecodedLines: 20_000_000,
  maxLineLength: 20_000,
  maxCommentLength: 500,
  maxMalformedLineWarnings: 1,
  maxUnsupportedCommandSamples: 20,
  maxArcSubdivisionsPerArc: 1000,
  strictChecksums: false,
};

export interface AnalyzeOptions {
  isCancelled?: () => boolean;
  onProgress?: (stage: string) => void;
}

export interface AnalyzeResult {
  status: GCodeResultStatus;
  statistics: GCodeStatistics;
  timing: TimingEstimate;
  dialect: DialectInference;
  layers: DetectedLayer[];
  layerDetectionMode: LayerDetectionMode;
  nonPlanarDetected: boolean;
  render: RenderBuffers;
  warnings: string[];
  unsupportedCommandSamples: string[];
  stoppedReason: string | null;
}

function paramValue(words: { letter: string; value: number | null; finite: boolean }[], letter: string): number | null {
  const w = words.find((x) => x.letter === letter);
  return w && w.finite ? w.value : null;
}

export async function analyzeGCode(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  limits: AnalyzeLimits = DEFAULT_ANALYZE_LIMITS,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  options.onProgress?.("Reading file");

  const decoder = new ChunkedLineDecoder({ maxLineLength: limits.maxLineLength });
  let modalState: ModalState = createInitialModalState();
  const segments: MoveSegment[] = [];
  const layerEvents: LayerLineEvent[] = [];
  const commentSignals: SlicerCommentSignal[] = [];
  const warnings: string[] = [];
  const unsupportedCommandSamples: string[] = [];

  let currentFeatureLabel: string | null = null;
  let lineIndex = 0;
  let fileBytes = 0;
  let malformedLines = 0;
  let unknownCommandLines = 0;
  let dwellSeconds = 0;
  let checksumValid = 0;
  let checksumMissing = 0;
  let checksumMismatched = 0;
  let linearMoveLineCount = 0;
  let arcLineCount = 0;
  let stoppedReason: string | null = null;
  let slicerProvidedTimeSeconds: number | null = null;
  const toolTemperatureSetpoints: Record<number, number[]> = {};
  const bedTemperatureSetpoints: number[] = [];
  let fanStateChanges = 0;

  function processLine(rawLine: string): void {
    lineIndex++;

    if (lineIndex > limits.maxDecodedLines) {
      stoppedReason = "line-count-ceiling";
      return;
    }

    const checksumResult = verifyChecksum(rawLine);
    if (checksumResult.status === "valid") checksumValid++;
    else if (checksumResult.status === "missing") checksumMissing++;
    else checksumMismatched++;

    const token = tokenizeLine(rawLine, { maxCommentLength: limits.maxCommentLength });
    if (token.malformedTokenCount > 0) malformedLines++;

    let signal: SlicerCommentSignal | null = null;
    if (token.comment) {
      signal = parseSlicerComment(token.comment);
      commentSignals.push(signal);
      if (signal.featureLabel !== null) currentFeatureLabel = signal.featureLabel;
      if (signal.estimatedPrintTimeSeconds !== null) slicerProvidedTimeSeconds = signal.estimatedPrintTimeSeconds;
    }

    const gWord = token.words.find((w) => w.letter === "G" && w.finite);
    const mWord = token.words.find((w) => w.letter === "M" && w.finite);
    const gCode = gWord ? Math.trunc(gWord.value!) : null;
    const mCode = mWord ? Math.trunc(mWord.value!) : null;

    let moveZ: number | null = null;
    let moveCategory: MoveCategory | null = null;

    if (gCode === 0 || gCode === 1) {
      linearMoveLineCount++;
      const result = applyLinearMove(modalState, gCode, token);
      modalState = result.state;
      segments.push({
        start: result.move.start,
        end: result.move.end,
        category: result.move.category,
        feature: classifyFeatureLabel(currentFeatureLabel, result.move.category),
        tool: result.move.tool,
        feedRate: result.move.feedRate,
        eDelta: result.move.eDelta,
        rapid: result.move.rapid,
        volumetric: result.move.volumetric,
        layerIndex: null,
        sourceLineIndex: lineIndex,
        temperature: result.move.temperature,
      });
      moveZ = result.move.end.z;
      moveCategory = result.move.category;
    } else if (gCode === 2 || gCode === 3) {
      arcLineCount++;
      const arcResult = applyArcMove(
        modalState,
        gCode,
        token,
        { ...DEFAULT_ARC_LIMITS, maxSegmentsPerArc: limits.maxArcSubdivisionsPerArc },
        { isCancelled: options.isCancelled },
      );
      modalState = arcResult.state;

      if (!arcResult.ok) {
        warnings.push(`Arc at line ${lineIndex} could not be resolved (${arcResult.reason}) and was skipped — never drawn as a straight line.`);
      } else {
        const overallCategory = arcResult.eDelta > 0 ? "extrusion" : arcResult.eDelta < 0 ? "retract" : "travel";
        const feature = classifyFeatureLabel(currentFeatureLabel, overallCategory);
        for (const arcSegment of arcResult.segments) {
          segments.push({
            start: arcSegment.start,
            end: arcSegment.end,
            category: overallCategory,
            feature,
            tool: modalState.activeTool,
            feedRate: arcResult.feedRate,
            eDelta: arcSegment.eEnd - arcSegment.eStart,
            rapid: false,
            volumetric: arcResult.state.volumetric,
            layerIndex: null,
            sourceLineIndex: lineIndex,
            temperature: arcResult.temperature,
          });
        }
        if (arcResult.subdivisionCeilingHit && !warnings.some((w) => w.includes("subdivision ceiling"))) {
          warnings.push("One or more arcs exceeded this viewer's per-arc subdivision ceiling and were rendered at a coarser resolution.");
        }
      }
      moveZ = arcResult.state.position.z;
      moveCategory = arcResult.ok ? segments[segments.length - 1]?.category ?? null : null;
    } else if (gCode === 4) {
      dwellSeconds += parseDwellSeconds(token);
      modalState = applyModalCommand(modalState, token);
    } else if (gCode !== null && !KNOWN_MOTION_G_CODES.has(gCode)) {
      unknownCommandLines++;
      if (unsupportedCommandSamples.length < limits.maxUnsupportedCommandSamples) unsupportedCommandSamples.push(`G${gCode}`);
      modalState = applyModalCommand(modalState, token);
    } else {
      modalState = applyModalCommand(modalState, token);
    }

    if (mCode === 104 || mCode === 109) {
      const s = paramValue(token.words, "S");
      if (s !== null) {
        const tool = modalState.activeTool;
        (toolTemperatureSetpoints[tool] ??= []).push(s);
      }
    } else if (mCode === 140 || mCode === 190) {
      const s = paramValue(token.words, "S");
      if (s !== null) bedTemperatureSetpoints.push(s);
    } else if (mCode === 106 || mCode === 107) {
      fanStateChanges++;
    }

    layerEvents.push({ lineIndex, commentSignal: signal, moveZ, moveCategory });
  }

  let chunkCounter = 0;
  for await (const chunk of chunks) {
    fileBytes += chunk.byteLength;
    if (fileBytes > limits.maxFileBytes) {
      stoppedReason = "file-size-ceiling";
      break;
    }
    for (const line of decoder.pushChunk(chunk)) processLine(line.text);
    chunkCounter++;
    await yieldIfCancelled(chunkCounter, YIELD_EVERY_CHUNKS, options.isCancelled);
    if (stoppedReason) break;
  }
  if (!stoppedReason) {
    for (const line of decoder.finish()) processLine(line.text);
  }

  if (fileBytes === 0) throw gcodeError("GCODE_EMPTY_FILE");

  options.onProgress?.("Detecting layers");
  const layerResult = detectLayers(layerEvents);

  if (layerResult.layers.length > 0) {
    const layersByLine = layerResult.layers.map((l) => ({ layer: l, endLine: Infinity }));
    for (let i = 0; i < layersByLine.length - 1; i++) layersByLine[i].endLine = layersByLine[i + 1].layer.startLineIndex;

    let layerCursor = 0;
    for (const segment of segments) {
      while (layerCursor < layersByLine.length - 1 && segment.sourceLineIndex >= layersByLine[layerCursor].endLine) layerCursor++;
      if (segment.sourceLineIndex >= layersByLine[layerCursor].layer.startLineIndex) {
        segment.layerIndex = layersByLine[layerCursor].layer.index;
      }
    }
  }

  options.onProgress?.("Classifying toolpaths");
  const dialect = inferDialect(commentSignals);

  options.onProgress?.("Building render buffers");
  const render = packRenderBuffers(segments, DEFAULT_RENDER_BUFFER_LIMITS);

  options.onProgress?.("Computing statistics");
  const statistics = computeStatistics({
    fileBytes,
    decodedLines: lineIndex,
    malformedLines,
    unknownCommandLines,
    checksumCounts: { valid: checksumValid, missing: checksumMissing, mismatched: checksumMismatched },
    linearMoveLineCount,
    arcLineCount,
    layers: layerResult.layers,
    toolTemperatureSetpoints,
    bedTemperatureSetpoints,
    fanStateChanges,
    segments,
  });

  const timing = buildTimingEstimate({ slicerProvidedSeconds: slicerProvidedTimeSeconds, segments, dwellSeconds });

  if (limits.strictChecksums && checksumMismatched > 0) {
    warnings.push(`${checksumMismatched} line(s) failed checksum verification.`);
  } else if (checksumMismatched > 0) {
    warnings.push(`${checksumMismatched} line(s) had a mismatched checksum — shown anyway; checksum validity doesn't determine whether a file is safe to print.`);
  }
  if (malformedLines > 0) {
    warnings.push(`${malformedLines} line(s) contained a malformed token that couldn't be parsed and was skipped.`);
  }
  if (unknownCommandLines > 0) {
    warnings.push(`${unknownCommandLines} unsupported command(s) were found and skipped (never faked as straight lines): ${unsupportedCommandSamples.join(", ")}.`);
  }
  if (layerResult.note) warnings.push(layerResult.note);

  options.onProgress?.("Ready");

  let status: GCodeResultStatus;
  if (stoppedReason) status = "partial";
  else if (segments.length === 0 && lineIndex > 0) status = "unsupported";
  else if (warnings.length > 0) status = "ready-with-warnings";
  else status = "ready";

  return {
    status,
    statistics,
    timing,
    dialect,
    layers: layerResult.layers,
    layerDetectionMode: layerResult.mode,
    nonPlanarDetected: layerResult.nonPlanarDetected,
    render,
    warnings,
    unsupportedCommandSamples,
    stoppedReason,
  };
}
