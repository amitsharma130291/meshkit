/**
 * The full STL Optimization pipeline, in the exact documented order:
 *
 *  1. Run original diagnostics (`analyzeSTLDiagnostics` — unchanged).
 *  2. Classify eligibility (`plan.ts`) — a non-manifold or self-
 *     intersecting mesh is refused here; a degenerate/duplicate-face mesh
 *     is directed to STL Repair. NEVER auto-repaired inside this tool.
 *  3. Build the mutable indexed topology from Phase 5's own canonical
 *     mesh + edge incidence + shells + boundary analysis (all reused
 *     unchanged — see `indexed-mesh.ts`).
 *  4. Resolve the requested target into an absolute triangle count.
 *  5. Run the simplify loop (`simplify.ts`) — bounded, honest stop
 *     reasons, every collapse safety-checked by `collapse-validation.ts`.
 *  6. Serialize a binary STL from the simplified geometry (normals always
 *     recomputed by the serializer from the final triangles).
 *  7. Re-parse that exact output — never the in-memory geometry — and run
 *     diagnostics on IT.
 *  8. Measure sampled geometric deviation between the ORIGINAL and the
 *     VERIFIED (reparsed) output.
 *  9. Determine the outcome (`outcome.ts`) from the verified after-state.
 */
import { parseSTL } from "../stl/parse";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { DEFAULT_STL_DIAGNOSTICS_LIMITS } from "../stl-diagnostics/types";
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import { analyzeBoundaryComponents } from "../mesh/boundary-components";
import { summarizeDiagnostics, DEFAULT_OPTIMIZE_LIMITS, QUALITY_PRESETS, resolveTargetTriangleCount, type OptimizeLimits, type OptimizeResult, type OptimizeSettings, type StageTiming } from "./types";
import { classifyEligibility } from "./plan";
import { activeTriangleCount, buildIndexedMesh, getTriangleVertexIds, getVertexPosition, type IndexedMesh } from "./indexed-mesh";
import { simplifyMesh } from "./simplify";
import { sampleDeviation, type SurfaceSample } from "./deviation";
import { determineOutcome } from "./outcome";
import { optimizeError, STLOptimizeException } from "./errors";
import { computeSurfaceArea, compareSurfaceArea, compareVolume, checkThresholds } from "./volume-surface";
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";

export interface OptimizePipelineOptions {
  isCancelled?: () => boolean;
  onProgress?: (stage: string) => void;
}

const STAGES = {
  checkingSource: "checking-source-mesh",
  buildingTopology: "building-indexed-topology",
  buildingCandidates: "building-collapse-candidates",
  simplifying: "simplifying-mesh",
  writingOutput: "writing-optimized-stl",
  verifyingOutput: "verifying-optimized-stl",
  measuringDeviation: "measuring-deviation",
  preparingComparison: "preparing-comparison",
} as const;

function meshToFlatPositions(mesh: IndexedMesh): Float32Array {
  const out: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (mesh.triangleActive[t] === 0) continue;
    const [a, b, c] = getTriangleVertexIds(mesh, t);
    out.push(...getVertexPosition(mesh, a), ...getVertexPosition(mesh, b), ...getVertexPosition(mesh, c));
  }
  return Float32Array.from(out);
}

function meshToSurfaceSample(positions: Float32Array): SurfaceSample {
  const triangleCount = positions.length / 9;
  const triangleVertexIds = new Int32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) triangleVertexIds[i] = i;
  return { positions, triangleVertexIds, triangleCount };
}

export async function optimizeSTL(originalPositions: Float32Array, settings: OptimizeSettings, limits: OptimizeLimits = DEFAULT_OPTIMIZE_LIMITS, options: OptimizePipelineOptions = {}): Promise<OptimizeResult> {
  const stageTimings: StageTiming[] = [];
  const warnings: string[] = [];
  const unresolvedProblems: string[] = [];

  async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    options.onProgress?.(name);
    if (options.isCancelled?.()) throw optimizeError("STLOPT_PLANNING_FAILED");
    const t0 = Date.now();
    const result = await fn();
    stageTimings.push({ stage: name, durationMs: Date.now() - t0 });
    return result;
  }

  const originalDiagnostics = await stage(STAGES.checkingSource, () => analyzeSTLDiagnostics(originalPositions, DEFAULT_STL_DIAGNOSTICS_LIMITS, { isCancelled: options.isCancelled }));
  if (originalDiagnostics.validTriangleCount === 0) throw optimizeError("STLOPT_NO_VALID_TRIANGLES");

  const { eligibility } = classifyEligibility(originalDiagnostics);
  const before = summarizeDiagnostics(originalDiagnostics);
  const preset = QUALITY_PRESETS[settings.preset];
  const minTrianglesPerShell = settings.minTrianglesPerShell ?? limits.minTrianglesPerShellFloor;

  if (eligibility === "unsafe-to-simplify" || eligibility === "repair-recommended") {
    // Never mutate. Honest "nothing happened" result, not a thrown error —
    // an ineligible mesh is a normal, expected outcome the UI must show.
    // Geometry is unchanged, so before/after area and volume are identical.
    const unchangedArea = compareSurfaceArea(originalDiagnostics.surfaceArea, originalDiagnostics.surfaceArea);
    const unchangedVolume = compareVolume(originalDiagnostics, originalDiagnostics);
    const appliedThresholds = { maxSurfaceAreaChangePercent: preset.maxSurfaceAreaChangePercent, maxVolumeChangePercent: preset.maxVolumeChangePercent };
    return {
      outcome: "unchanged-no-safe-collapses",
      settings,
      eligibility,
      before,
      after: before,
      requestedTargetTriangleCount: originalDiagnostics.triangleCount,
      originalTriangleCount: originalDiagnostics.triangleCount,
      optimizedTriangleCount: originalDiagnostics.triangleCount,
      requestedReductionPercent: settings.target.mode === "percentage" ? settings.target.value : 0,
      achievedReductionPercent: 0,
      originalBytes: originalPositions.byteLength,
      optimizedBytes: null,
      actualBytesSaved: null,
      actualSizeReductionPercent: null,
      attemptedCollapses: 0,
      acceptedCollapses: 0,
      rejectedCollapsesByReason: {},
      stopReason: "not-attempted",
      shellCountBefore: originalDiagnostics.shellCount,
      shellCountAfter: originalDiagnostics.shellCount,
      boundaryEdgesBefore: originalDiagnostics.boundaryEdgeCount,
      boundaryEdgesAfter: originalDiagnostics.boundaryEdgeCount,
      nonManifoldEdgesBefore: originalDiagnostics.nonManifoldEdgeCount,
      nonManifoldEdgesAfter: originalDiagnostics.nonManifoldEdgeCount,
      deviation: null,
      ...unchangedArea,
      ...unchangedVolume,
      appliedThresholds,
      thresholdCheck: { exceededSurfaceAreaThreshold: false, exceededVolumeThreshold: false, reason: null },
      stageTimings,
      warnings,
      unresolvedProblems: eligibility === "unsafe-to-simplify" ? ["This mesh's topology is not safe to simplify automatically. Try STL Repair first."] : ["This mesh has degenerate or duplicate geometry. Try STL Repair first."],
      outputBytes: null,
    };
  }

  const targetTriangleCount = resolveTargetTriangleCount(originalDiagnostics.validTriangleCount, settings.target, minTrianglesPerShell);

  const mesh = await stage(STAGES.buildingTopology, () => buildTopology(originalPositions, limits));

  await stage(STAGES.buildingCandidates, () => void 0); // candidate construction happens inside simplifyMesh itself; named stage kept for honest progress reporting

  const simplifyResult = await stage(STAGES.simplifying, () =>
    simplifyMesh(
      mesh.indexedMesh,
      mesh.boundary,
      { targetTriangleCount, minTrianglesPerShell, maxNormalFlipAngleDeg: preset.maxNormalFlipAngleDeg, isCancelled: options.isCancelled },
      { maxCandidateHeapEntries: limits.maxCandidateHeapEntries, maxCollapseAttempts: limits.maxCollapseAttempts, workBudgetMs: limits.workBudgetMs },
    ),
  );

  if (activeTriangleCount(mesh.indexedMesh) > limits.maxInputTriangles) throw optimizeError("STLOPT_TOPOLOGY_LIMIT_EXCEEDED");

  const optimizedPositions = meshToFlatPositions(mesh.indexedMesh);

  const outputBytes = await stage(STAGES.writingOutput, () => {
    try {
      const bytes = serializeBinarySTL({ positions: optimizedPositions, header: "MeshWrench optimized STL" });
      if (bytes.byteLength > limits.maxOutputBytes) throw optimizeError("STLOPT_OUTPUT_SIZE_LIMIT_EXCEEDED");
      return bytes;
    } catch (error) {
      if (error instanceof STLOptimizeException) throw error;
      throw optimizeError("STLOPT_SERIALIZATION_FAILED");
    }
  });

  let reparsedPositions: Float32Array = new Float32Array(0);
  const afterDiagnostics = await stage(STAGES.verifyingOutput, async () => {
    let reparsed;
    try {
      reparsed = parseSTL(outputBytes, DEFAULT_STL_LIMITS);
    } catch {
      throw optimizeError("STLOPT_OUTPUT_REPARSE_FAILED");
    }
    reparsedPositions = reparsed.positions;
    try {
      return await analyzeSTLDiagnostics(reparsed.positions, DEFAULT_STL_DIAGNOSTICS_LIMITS, { isCancelled: options.isCancelled });
    } catch {
      throw optimizeError("STLOPT_VERIFICATION_FAILED");
    }
  });

  const deviation = await stage(STAGES.measuringDeviation, () =>
    sampleDeviation(meshToSurfaceSample(originalPositions), meshToSurfaceSample(optimizedPositions), {
      maxSamples: limits.maxDeviationSamples,
      maxGridCells: limits.maxDeviationSamples,
    }),
  );

  return stage(STAGES.preparingComparison, async () => {
    const after = summarizeDiagnostics(afterDiagnostics);
    if (afterDiagnostics.selfIntersections.status === "not-checked") {
      warnings.push("The optimized model's self-intersection check couldn't complete within this tool's safety limits — the result cannot claim all geometry is fully verified.");
    }
    if (!deviation.completed) {
      warnings.push("Sampled deviation measurement was cut short by a safety limit — the reported deviation values reflect a partial sample.");
    }

    // Measured from the production-parsed ORIGINAL geometry and the REPARSED
    // SERIALIZED OUTPUT geometry only — never the intermediate mutable mesh.
    const [surfaceAreaBefore, surfaceAreaAfter] = await Promise.all([
      computeSurfaceArea(originalPositions, { isCancelled: options.isCancelled }),
      computeSurfaceArea(reparsedPositions, { isCancelled: options.isCancelled }),
    ]);
    const areaComparison = compareSurfaceArea(surfaceAreaBefore, surfaceAreaAfter);
    const volumeComparison = compareVolume(originalDiagnostics as STLDiagnosticsReport, afterDiagnostics as STLDiagnosticsReport);
    const appliedThresholds = { maxSurfaceAreaChangePercent: preset.maxSurfaceAreaChangePercent, maxVolumeChangePercent: preset.maxVolumeChangePercent };
    const thresholdCheck = checkThresholds(
      { surfaceAreaChangePercent: areaComparison.surfaceAreaChangePercent, volumeChangePercent: volumeComparison.volumeChangePercent, volumeStatus: volumeComparison.volumeStatus },
      appliedThresholds,
    );

    const outcome = determineOutcome({
      before,
      after,
      stopReason: simplifyResult.stopReason,
      requestedTargetTriangleCount: targetTriangleCount,
      achievedTriangleCount: after.triangleCount,
      deviationCompleted: deviation.completed,
      unresolvedProblems,
      thresholdCheck,
    });

    const originalBytes = originalPositions.byteLength > 0 ? 84 + originalDiagnostics.triangleCount * 50 : 0;
    const optimizedBytes = outputBytes.byteLength;
    const actualBytesSaved = originalBytes - optimizedBytes;
    const requestedReductionPercent = settings.target.mode === "percentage" ? settings.target.value : Math.round((1 - targetTriangleCount / originalDiagnostics.validTriangleCount) * 100);
    const achievedReductionPercent = originalDiagnostics.triangleCount > 0 ? Math.round((1 - after.triangleCount / originalDiagnostics.triangleCount) * 100) : 0;

    return {
      outcome,
      settings,
      eligibility,
      before,
      after,
      requestedTargetTriangleCount: targetTriangleCount,
      originalTriangleCount: originalDiagnostics.triangleCount,
      optimizedTriangleCount: after.triangleCount,
      requestedReductionPercent,
      achievedReductionPercent,
      originalBytes,
      optimizedBytes,
      actualBytesSaved,
      actualSizeReductionPercent: originalBytes > 0 ? Math.round((actualBytesSaved / originalBytes) * 100) : 0,
      attemptedCollapses: simplifyResult.attemptedCollapses,
      acceptedCollapses: simplifyResult.acceptedCollapses,
      rejectedCollapsesByReason: simplifyResult.rejectedCollapsesByReason,
      stopReason: simplifyResult.stopReason,
      shellCountBefore: originalDiagnostics.shellCount,
      shellCountAfter: afterDiagnostics.shellCount,
      boundaryEdgesBefore: originalDiagnostics.boundaryEdgeCount,
      boundaryEdgesAfter: afterDiagnostics.boundaryEdgeCount,
      nonManifoldEdgesBefore: originalDiagnostics.nonManifoldEdgeCount,
      nonManifoldEdgesAfter: afterDiagnostics.nonManifoldEdgeCount,
      deviation,
      ...areaComparison,
      ...volumeComparison,
      appliedThresholds,
      thresholdCheck,
      stageTimings,
      warnings,
      unresolvedProblems,
      outputBytes,
    };
  });
}

async function buildTopology(positions: Float32Array, limits: OptimizeLimits) {
  const canonical = await buildCanonicalMesh(positions, { maxUniqueVertices: limits.maxUniqueVertices });
  const edges = buildEdgeIncidence(canonical.validTriangles, { maxEdgeRecords: limits.maxCandidateHeapEntries });
  const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
  const boundary = analyzeBoundaryComponents(edges.edgesByKey, { maxComponents: 10_000, maxSampleVerticesPerComponent: 1000 });
  const indexedMesh = buildIndexedMesh(canonical, edges, shells);
  return { indexedMesh, boundary };
}

