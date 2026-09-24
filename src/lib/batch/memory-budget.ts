/**
 * A deterministic, conservative memory estimator for one batch session.
 * Browser memory usage can't be measured exactly from JS, so every
 * number here is an ESTIMATE — good enough to refuse a job that would
 * clearly overrun the tab, never a claim of precise measurement.
 *
 * If a job doesn't fit, callers keep it queued or fail it with a safe
 * explanation (`BATCH_MEMORY_BUDGET_EXCEEDED`) — this module never
 * throws, never starts a job optimistically, and never reports a whole
 * batch successful because of budget pressure on one file.
 */
import type { BatchOperationId } from "./types";

/** Conservative in-memory expansion relative to source file size — a parsed/decoded mesh (positions+normals+intermediate buffers) is always larger than the encoded file on disk. */
export const OPERATION_MEMORY_MULTIPLIERS: Record<BatchOperationId, number> = {
  "convert-3mf-to-stl": 6,
  "convert-obj-to-stl": 4,
  "convert-glb-to-stl": 5,
  "convert-ply-to-stl": 4,
  "convert-stl-to-obj": 3,
  "convert-stl-to-3mf": 3,
  "repair-stl": 5,
  "optimize-stl": 5,
};

export interface MemoryBudgetLimits {
  maxTotalBytes: number;
}

export interface MemoryEstimate {
  scheduledInputBytes: number;
  activeInputBytes: number;
  estimatedParserExpansionBytes: number;
  retainedSuccessfulOutputBytes: number;
  pendingZipGenerationBytes: number;
}

interface ActiveReservation {
  inputBytes: number;
  expansionBytes: number;
}

export class MemoryBudget {
  private readonly limits: MemoryBudgetLimits;
  private readonly active = new Map<string, ActiveReservation>();
  private readonly retainedOutputs = new Map<string, number>();
  private pendingZipBytes = 0;

  constructor(limits: MemoryBudgetLimits) {
    this.limits = limits;
  }

  private totalReservedBytes(): number {
    let total = this.pendingZipBytes;
    for (const output of this.retainedOutputs.values()) total += output;
    for (const reservation of this.active.values()) total += reservation.inputBytes + reservation.expansionBytes;
    return total;
  }

  private estimateFootprint(operationId: BatchOperationId, inputBytes: number): ActiveReservation {
    const multiplier = OPERATION_MEMORY_MULTIPLIERS[operationId];
    return { inputBytes, expansionBytes: inputBytes * multiplier };
  }

  /** `jobId` isn't used in the estimate itself — kept for signature symmetry with `reserve()`, and in case a future policy needs to exclude a job's own prior reservation when re-checking it. */
  canSchedule(_jobId: string, operationId: BatchOperationId, inputBytes: number): boolean {
    const { inputBytes: reservedInput, expansionBytes } = this.estimateFootprint(operationId, inputBytes);
    return this.totalReservedBytes() + reservedInput + expansionBytes <= this.limits.maxTotalBytes;
  }

  reserve(jobId: string, operationId: BatchOperationId, inputBytes: number): void {
    this.active.set(jobId, this.estimateFootprint(operationId, inputBytes));
  }

  release(jobId: string): void {
    this.active.delete(jobId);
  }

  retainOutput(jobId: string, outputBytes: number): void {
    this.retainedOutputs.set(jobId, outputBytes);
  }

  releaseOutput(jobId: string): void {
    this.retainedOutputs.delete(jobId);
  }

  /** Refuses (and reserves nothing) if the ZIP's own estimated footprint alone would exceed budget. */
  reserveForZip(estimatedBytes: number): boolean {
    if (this.totalReservedBytes() + estimatedBytes > this.limits.maxTotalBytes) return false;
    this.pendingZipBytes = estimatedBytes;
    return true;
  }

  releaseZip(): void {
    this.pendingZipBytes = 0;
  }

  currentEstimate(): MemoryEstimate {
    let activeInputBytes = 0;
    let estimatedParserExpansionBytes = 0;
    for (const reservation of this.active.values()) {
      activeInputBytes += reservation.inputBytes;
      estimatedParserExpansionBytes += reservation.expansionBytes;
    }
    let retainedSuccessfulOutputBytes = 0;
    for (const bytes of this.retainedOutputs.values()) retainedSuccessfulOutputBytes += bytes;

    return {
      scheduledInputBytes: activeInputBytes,
      activeInputBytes,
      estimatedParserExpansionBytes,
      retainedSuccessfulOutputBytes,
      pendingZipGenerationBytes: this.pendingZipBytes,
    };
  }
}
