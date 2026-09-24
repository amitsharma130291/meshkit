/**
 * Surface-area and closed-shell-volume comparison for STL Optimization's
 * verified result. Surface area is computed directly from raw
 * triangle-soup positions (never an intermediate mutable/indexed mesh —
 * `optimize.ts` calls this against the production-parsed ORIGINAL
 * geometry and the REPARSED SERIALIZED OUTPUT geometry only). Volume
 * reuses Phase 5's own translation-stable signed-volume and shell-
 * orientation infrastructure completely unchanged (`mesh/orientation.ts`
 * via `stl-diagnostics/analyze.ts`'s already-computed `STLDiagnosticsReport`)
 * — no second volume definition.
 */
import { CancellationRequested, yieldIfCancelled } from "../cancellation";
import type { STLDiagnosticsReport } from "../stl-diagnostics/types";

const YIELD_EVERY_TRIANGLES = 2000;

export interface SurfaceAreaOptions {
  isCancelled?: () => boolean;
}

/** Sums each triangle's own area (½|edge1 × edge2|) directly from a flat, non-indexed positions buffer. Throws on any non-finite coordinate rather than silently producing NaN/Infinity. */
export async function computeSurfaceArea(positions: Float32Array, options: SurfaceAreaOptions = {}): Promise<number> {
  const triangleCount = positions.length / 9;
  let total = 0;
  for (let t = 0; t < triangleCount; t++) {
    await yieldIfCancelled(t, YIELD_EVERY_TRIANGLES, options.isCancelled);

    const base = t * 9;
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];

    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) {
      throw new Error("computeSurfaceArea: non-finite coordinate");
    }

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const crossX = e1y * e2z - e1z * e2y;
    const crossY = e1z * e2x - e1x * e2z;
    const crossZ = e1x * e2y - e1y * e2x;

    total += 0.5 * Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
  }
  // Cooperative cancellation check after the loop too, for a triangle count below YIELD_EVERY_TRIANGLES.
  if (options.isCancelled?.()) throw new CancellationRequested();
  return total;
}

export interface SurfaceAreaComparison {
  surfaceAreaBefore: number;
  surfaceAreaAfter: number;
  surfaceAreaChange: number;
  surfaceAreaChangePercent: number | null;
}

export function compareSurfaceArea(before: number, after: number): SurfaceAreaComparison {
  const change = after - before;
  return {
    surfaceAreaBefore: before,
    surfaceAreaAfter: after,
    surfaceAreaChange: change,
    surfaceAreaChangePercent: before === 0 ? null : (change / before) * 100,
  };
}

// --- Volume ---------------------------------------------------------------

export type VolumeStatus = "completed" | "not-applicable" | "indeterminate";

interface VolumeEligibility {
  status: VolumeStatus;
  reason?: string;
  /** Sum of every eligible shell's own |signedVolume| — never a signed net total, since MeshWrench's shells represent separate solid parts, not nested cavities. `null` unless `status === "completed"`. */
  magnitude: number | null;
}

/**
 * A mesh-wide volume figure is only ever reported when EVERY shell in the
 * mesh is closed, consistently orientable, and determinately oriented —
 * deliberately stricter than `stl-diagnostics/analyze.ts`'s own
 * `totalEnclosedVolume` (which silently sums only the shells that
 * qualify and stays non-null as long as at least one does). A single
 * open or contradictory shell makes the WHOLE model's volume comparison
 * `not-applicable`/`indeterminate` rather than silently reporting a
 * partial sum a user could mistake for the whole model.
 */
export function classifyMeshVolume(report: STLDiagnosticsReport): VolumeEligibility {
  if (report.shellCount === 0) {
    return { status: "not-applicable", reason: "No shells found.", magnitude: null };
  }
  if (report.shellsTruncated) {
    return { status: "indeterminate", reason: "Too many shells to verify every shell's orientation.", magnitude: null };
  }
  const openShell = report.shells.find((s) => !s.closed);
  if (openShell) {
    return { status: "not-applicable", reason: "At least one shell has an open boundary.", magnitude: null };
  }
  const indeterminateShell = report.shells.find((s) => !s.consistentlyOrientable || s.orientation === "indeterminate");
  if (indeterminateShell) {
    return {
      status: "indeterminate",
      reason: "At least one shell's orientation could not be consistently determined (inconsistent winding or a near-zero volume).",
      magnitude: null,
    };
  }
  const magnitude = report.shells.reduce((sum, shell) => sum + Math.abs(shell.signedVolume ?? 0), 0);
  return { status: "completed", magnitude };
}

export interface VolumeComparison {
  volumeBefore: number | null;
  volumeAfter: number | null;
  volumeChange: number | null;
  volumeChangePercent: number | null;
  volumeStatus: VolumeStatus;
  volumeReason?: string;
}

const STATUS_SEVERITY: Record<VolumeStatus, number> = { completed: 0, "not-applicable": 1, indeterminate: 2 };

export function compareVolume(before: STLDiagnosticsReport, after: STLDiagnosticsReport): VolumeComparison {
  const beforeEligibility = classifyMeshVolume(before);
  const afterEligibility = classifyMeshVolume(after);

  if (beforeEligibility.status === "completed" && afterEligibility.status === "completed") {
    const volumeBefore = beforeEligibility.magnitude!;
    const volumeAfter = afterEligibility.magnitude!;
    const change = volumeAfter - volumeBefore;
    return {
      volumeBefore,
      volumeAfter,
      volumeChange: change,
      volumeChangePercent: volumeBefore === 0 ? null : (change / volumeBefore) * 100,
      volumeStatus: "completed",
    };
  }

  // Whichever side is less eligible ("indeterminate" outranks "not-applicable") decides the overall status/reason.
  const worse = STATUS_SEVERITY[afterEligibility.status] >= STATUS_SEVERITY[beforeEligibility.status] ? afterEligibility : beforeEligibility;
  return {
    volumeBefore: null,
    volumeAfter: null,
    volumeChange: null,
    volumeChangePercent: null,
    volumeStatus: worse.status,
    volumeReason: worse.reason,
  };
}

// --- Thresholds ---------------------------------------------------------

export interface AreaVolumeMetricsInput {
  surfaceAreaChangePercent: number | null;
  volumeChangePercent: number | null;
  volumeStatus: VolumeStatus;
}

export interface ThresholdPreset {
  maxSurfaceAreaChangePercent: number;
  maxVolumeChangePercent: number;
}

export interface ThresholdCheckResult {
  exceededSurfaceAreaThreshold: boolean;
  exceededVolumeThreshold: boolean;
  reason: string | null;
}

/**
 * Compares a result's own surface-area/volume percentage change against a
 * preset's own quality-policy thresholds (never a manufacturing tolerance —
 * see `types.ts`'s `QualityPreset` doc comment). The volume threshold is
 * only ever enforced when volume was actually measurable on both sides
 * (`volumeStatus === "completed"`) — open or indeterminate geometry never
 * produces a false threshold failure just because volume isn't reportable.
 */
export function checkThresholds(metrics: AreaVolumeMetricsInput, preset: ThresholdPreset): ThresholdCheckResult {
  const exceededSurfaceAreaThreshold =
    metrics.surfaceAreaChangePercent !== null && Math.abs(metrics.surfaceAreaChangePercent) > preset.maxSurfaceAreaChangePercent;
  const exceededVolumeThreshold =
    metrics.volumeStatus === "completed" &&
    metrics.volumeChangePercent !== null &&
    Math.abs(metrics.volumeChangePercent) > preset.maxVolumeChangePercent;

  const reasons: string[] = [];
  if (exceededSurfaceAreaThreshold) {
    reasons.push(
      `surface area changed by ${metrics.surfaceAreaChangePercent!.toFixed(2)}%, exceeding this preset's own ${preset.maxSurfaceAreaChangePercent}% limit`,
    );
  }
  if (exceededVolumeThreshold) {
    reasons.push(
      `volume changed by ${metrics.volumeChangePercent!.toFixed(2)}%, exceeding this preset's own ${preset.maxVolumeChangePercent}% limit`,
    );
  }

  return {
    exceededSurfaceAreaThreshold,
    exceededVolumeThreshold,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}
