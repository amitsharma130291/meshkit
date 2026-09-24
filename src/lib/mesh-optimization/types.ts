/**
 * Settings, limits, and the full result contract for STL Optimization.
 * Reuses `stl-repair/types.ts`'s own `DiagnosticsSummary`/
 * `summarizeDiagnostics()` unchanged rather than a third redefinition —
 * both phases summarize the exact same `STLDiagnosticsReport` shape for
 * the exact same before/after comparison purpose.
 */
import type { DiagnosticsSummary } from "../stl-repair/types";

export type { DiagnosticsSummary };
export { summarizeDiagnostics } from "../stl-repair/types";

// --- Eligibility -----------------------------------------------------------

export type EligibilityClass = "eligible" | "eligible-with-warnings" | "repair-recommended" | "unsafe-to-simplify";

// --- Targets -----------------------------------------------------------

export type SimplifyTargetMode = "percentage" | "triangle-count";

export interface SimplifyTarget {
  mode: SimplifyTargetMode;
  /** `percentage` mode: 1-99, the REDUCTION percentage (not retained %). `triangle-count` mode: the absolute target triangle count. */
  value: number;
}

/** Resolves a target into an absolute triangle count, clamped to a safe floor. Never below `minTriangles` (the safety floor), never above the source count. */
export function resolveTargetTriangleCount(sourceTriangleCount: number, target: SimplifyTarget, minTriangles: number): number {
  const raw = target.mode === "percentage" ? Math.round(sourceTriangleCount * (1 - target.value / 100)) : Math.round(target.value);
  return Math.max(minTriangles, Math.min(raw, sourceTriangleCount));
}

// --- Presets -----------------------------------------------------------

export type QualityPresetName = "preserve-details" | "balanced" | "maximum-reduction";

export interface QualityPreset {
  name: QualityPresetName;
  maxNormalFlipAngleDeg: number;
  /** Sharp-feature detection threshold (not currently enforced as a hard collapse-blocker — see `plan.ts`'s own disclosed scope note). */
  sharpEdgeAngleDeg: number;
  maxSampledDeviationRatio: number;
  /**
   * MeshWrench's own quality-policy limits on how far a verified result's
   * surface area / closed-shell volume may drift from the ORIGINAL
   * (measured on the production-parsed input vs. the reparsed serialized
   * output — never an intermediate mutable mesh). These are NOT
   * manufacturing tolerances or any external standard — they are this
   * tool's own disclosed threshold for what "safely reduced" means under
   * each preset. Exceeding either one caps the outcome below
   * `target-achieved`/`reduced-safely` — see `outcome.ts`.
   */
  maxSurfaceAreaChangePercent: number;
  /** Only enforced when volume is actually measurable (`volumeStatus === "completed"` on both sides) — never invented for open/indeterminate geometry. */
  maxVolumeChangePercent: number;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  "preserve-details": {
    name: "preserve-details",
    maxNormalFlipAngleDeg: 15,
    sharpEdgeAngleDeg: 25,
    maxSampledDeviationRatio: 0.002,
    maxSurfaceAreaChangePercent: 3,
    maxVolumeChangePercent: 2,
  },
  balanced: {
    name: "balanced",
    maxNormalFlipAngleDeg: 35,
    sharpEdgeAngleDeg: 40,
    maxSampledDeviationRatio: 0.01,
    maxSurfaceAreaChangePercent: 12,
    maxVolumeChangePercent: 8,
  },
  "maximum-reduction": {
    name: "maximum-reduction",
    maxNormalFlipAngleDeg: 60,
    sharpEdgeAngleDeg: 60,
    maxSampledDeviationRatio: 0.05,
    maxSurfaceAreaChangePercent: 35,
    maxVolumeChangePercent: 25,
  },
};

export interface OptimizeSettings {
  target: SimplifyTarget;
  preset: QualityPresetName;
  /** Only meaningful for `custom`-style callers overriding a preset's own defaults; `plan.ts` always resolves the effective policy from `preset` + these overrides. */
  minTrianglesPerShell?: number;
}

export function defaultOptimizeSettings(): OptimizeSettings {
  return { target: { mode: "percentage", value: 50 }, preset: "balanced" };
}

// --- Limits -----------------------------------------------------------

export interface OptimizeLimits {
  maxInputTriangles: number;
  maxUniqueVertices: number;
  maxCandidateHeapEntries: number;
  maxCollapseAttempts: number;
  minTrianglesPerShellFloor: number;
  maxOutputBytes: number;
  maxDeviationSamples: number;
  workBudgetMs: number;
  maxVisualizationSamples: number;
}

export const DEFAULT_OPTIMIZE_LIMITS: OptimizeLimits = {
  maxInputTriangles: 2_000_000,
  maxUniqueVertices: 1_500_000,
  maxCandidateHeapEntries: 4_000_000,
  maxCollapseAttempts: 2_000_000,
  minTrianglesPerShellFloor: 4,
  maxOutputBytes: 300 * 1024 * 1024,
  maxDeviationSamples: 20_000,
  workBudgetMs: 25_000,
  maxVisualizationSamples: 5_000,
};

// --- Outcome -----------------------------------------------------------

export type OptimizeOutcome =
  | "target-achieved"
  | "reduced-safely"
  | "partially-reduced"
  | "unchanged-no-safe-collapses"
  | "verification-incomplete"
  | "verification-failed"
  | "cancelled"
  | "failed";

// --- Deviation -----------------------------------------------------------

export interface SampledDeviationResult {
  maxDeviation: number;
  meanDeviation: number;
  rmsDeviation: number;
  sampleCount: number;
  completed: boolean;
  /** True only when a safety ceiling cut the sample set short — distinct from a clean, complete measurement. */
  incompleteDueToSafetyCeiling: boolean;
}

// --- Volume/surface -----------------------------------------------------------
//
// Field names and null-vs-number policy match the exact contract this
// phase's own closeout specified: surface area is always a real number
// (every valid mesh has a surface area); volume is `null` on both sides
// together with a `volumeStatus`/`volumeReason` whenever the geometry
// isn't a valid closed, consistently-oriented, determinate volume — see
// `volume-surface.ts`'s own `classifyMeshVolume()`/`compareVolume()`.

export type VolumeStatus = "completed" | "not-applicable" | "indeterminate";

export interface AreaVolumeMetrics {
  surfaceAreaBefore: number;
  surfaceAreaAfter: number;
  surfaceAreaChange: number;
  surfaceAreaChangePercent: number | null;
  volumeBefore: number | null;
  volumeAfter: number | null;
  volumeChange: number | null;
  volumeChangePercent: number | null;
  volumeStatus: VolumeStatus;
  volumeReason?: string;
}

/** Which of a preset's own quality-policy thresholds (never a manufacturing tolerance) a verified result exceeded, if any. */
export interface ThresholdCheckResult {
  exceededSurfaceAreaThreshold: boolean;
  exceededVolumeThreshold: boolean;
  reason: string | null;
}

// --- Result -----------------------------------------------------------

export interface StageTiming {
  stage: string;
  durationMs: number;
}

export interface OptimizeResult {
  outcome: OptimizeOutcome;
  settings: OptimizeSettings;
  eligibility: EligibilityClass;
  before: DiagnosticsSummary;
  after: DiagnosticsSummary | null;
  requestedTargetTriangleCount: number;
  originalTriangleCount: number;
  optimizedTriangleCount: number;
  requestedReductionPercent: number;
  achievedReductionPercent: number;
  originalBytes: number;
  optimizedBytes: number | null;
  actualBytesSaved: number | null;
  actualSizeReductionPercent: number | null;
  attemptedCollapses: number;
  acceptedCollapses: number;
  rejectedCollapsesByReason: Partial<Record<string, number>>;
  stopReason: string;
  shellCountBefore: number;
  shellCountAfter: number | null;
  boundaryEdgesBefore: number;
  boundaryEdgesAfter: number | null;
  nonManifoldEdgesBefore: number;
  nonManifoldEdgesAfter: number | null;
  deviation: SampledDeviationResult | null;
  surfaceAreaBefore: number;
  surfaceAreaAfter: number;
  surfaceAreaChange: number;
  surfaceAreaChangePercent: number | null;
  volumeBefore: number | null;
  volumeAfter: number | null;
  volumeChange: number | null;
  volumeChangePercent: number | null;
  volumeStatus: VolumeStatus;
  volumeReason?: string;
  /** The effective preset thresholds this result was checked against — always present, so the report/UI never has to re-derive them from `settings.preset`. */
  appliedThresholds: { maxSurfaceAreaChangePercent: number; maxVolumeChangePercent: number };
  thresholdCheck: ThresholdCheckResult;
  stageTimings: StageTiming[];
  warnings: string[];
  unresolvedProblems: string[];
  outputBytes: ArrayBuffer | null;
}
