/**
 * The main edge-collapse loop. Ties together `edge-candidates.ts` (cost
 * ordering via QEM), `collapse-heap.ts` (lazy-invalidated priority
 * queue), `collapse-validation.ts` (the safety policy) and
 * `indexed-mesh.ts` (the actual mutation) — this module owns none of
 * those concerns itself, only the stopping-condition and bookkeeping
 * logic that decides when to keep going and what to report.
 *
 * "Do not loop until results look good" / "do not rebuild and resort
 * every edge globally": every collapse only ever regenerates candidates
 * for the surviving vertex's own current neighbors
 * (`regenerateLocalCandidates`), and the loop has an explicit, bounded
 * set of stop reasons — never an unbounded "keep trying" condition.
 */
import { yieldIfCancelled } from "../cancellation";
import type { BoundaryAnalysis } from "../mesh/boundary-components";
import { boundaryEdgeKeysFromClosedLoops, DEFAULT_COLLAPSE_POLICY, validateCollapse, type CollapseRejectionReason } from "./collapse-validation";
import { buildInitialCandidates, computeVertexQuadrics, regenerateLocalCandidates, scoreEdge } from "./edge-candidates";
import { activeTriangleCount, collapseEdge, type IndexedMesh } from "./indexed-mesh";
import { addQuadric, type Quadric } from "./quadric";

export type StopReason =
  | "target-reached"
  | "no-safe-collapses-remain"
  | "work-budget-reached"
  | "collapse-attempt-limit-reached"
  | "candidate-heap-exhausted"
  | "cancelled";

export interface SimplifyOptions {
  targetTriangleCount: number;
  minTrianglesPerShell: number;
  maxNormalFlipAngleDeg: number;
  isCancelled?: () => boolean;
}

export interface SimplifyLimits {
  maxCandidateHeapEntries: number;
  maxCollapseAttempts: number;
  workBudgetMs: number;
}

export type RejectedCollapsesByReason = Partial<Record<CollapseRejectionReason, number>>;

export interface SimplifyResult {
  stopReason: StopReason;
  attemptedCollapses: number;
  acceptedCollapses: number;
  rejectedCollapsesByReason: RejectedCollapsesByReason;
}

const YIELD_EVERY = 200;

export async function simplifyMesh(mesh: IndexedMesh, boundary: BoundaryAnalysis, options: SimplifyOptions, limits: SimplifyLimits): Promise<SimplifyResult> {
  const quadrics: Quadric[] = computeVertexQuadrics(mesh);
  const boundaryEdgeKeys = boundaryEdgeKeysFromClosedLoops(boundary);
  const policy = { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys, minTrianglesPerShell: options.minTrianglesPerShell, maxNormalFlipAngleDeg: options.maxNormalFlipAngleDeg };
  const heapLimits = { maxEntries: limits.maxCandidateHeapEntries };
  const heap = buildInitialCandidates(mesh, quadrics, heapLimits);

  let attemptedCollapses = 0;
  let acceptedCollapses = 0;
  const rejectedCollapsesByReason: RejectedCollapsesByReason = {};
  const startedAt = Date.now();
  let iteration = 0;

  for (;;) {
    if (activeTriangleCount(mesh) <= options.targetTriangleCount) {
      return { stopReason: "target-reached", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }

    iteration += 1;
    try {
      await yieldIfCancelled(iteration, YIELD_EVERY, options.isCancelled);
    } catch {
      return { stopReason: "cancelled", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }

    if (Date.now() - startedAt > limits.workBudgetMs) {
      return { stopReason: "work-budget-reached", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }
    if (attemptedCollapses >= limits.maxCollapseAttempts) {
      return { stopReason: "collapse-attempt-limit-reached", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }

    const candidate = heap.pop();
    if (!candidate) {
      return { stopReason: "no-safe-collapses-remain", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }

    if (mesh.vertexActive[candidate.from] === 0 || mesh.vertexActive[candidate.to] === 0) {
      continue; // this edge no longer exists — discard permanently, not an attempt
    }
    if (candidate.versionAtInsertion !== mesh.version) {
      // Stale: recompute fresh at the current topology/version and give it another chance to surface as cheapest.
      try {
        heap.push(scoreEdge(mesh, quadrics, candidate.from, candidate.to, mesh.version));
      } catch {
        // Heap capacity reached mid-refresh — treat as exhausted rather than crash the whole run.
        return { stopReason: "candidate-heap-exhausted", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
      }
      continue;
    }

    attemptedCollapses += 1;
    const validation = validateCollapse(mesh, candidate.from, candidate.to, candidate.position, policy);
    if (!validation.safe) {
      const reason = validation.reason!;
      rejectedCollapsesByReason[reason] = (rejectedCollapsesByReason[reason] ?? 0) + 1;
      continue;
    }

    collapseEdge(mesh, candidate.from, candidate.to, candidate.position);
    quadrics[candidate.to] = addQuadric(quadrics[candidate.from], quadrics[candidate.to]);
    acceptedCollapses += 1;
    try {
      regenerateLocalCandidates(mesh, quadrics, candidate.to, heap, heapLimits);
    } catch {
      return { stopReason: "candidate-heap-exhausted", attemptedCollapses, acceptedCollapses, rejectedCollapsesByReason };
    }
  }
}
