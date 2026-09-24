/**
 * The full repair pipeline, in the exact documented order:
 *
 *  1. Run original diagnostics (`analyzeSTLDiagnostics` — unchanged).
 *  2. Build the repair plan (`planRepair` — pure, no mutation).
 *  3. Weld vertices (if enabled) — also removes any triangle whose
 *     vertices collapse as a direct result of welding.
 *  4. Remove degenerate triangles (repeated-vertex / exact-zero-area /
 *     near-zero-area, per settings).
 *  5. Remove duplicate faces (same- and reverse-winding).
 *  6. Correct winding — internal per-shell consistency, plus whole-shell
 *     outward reversal for closed+orientable+inward shells when
 *     requested (one combined pass — see `winding.ts`'s own doc comment
 *     for why running this as two separate passes would risk winding
 *     oscillation between them).
 *  7. Fill eligible boundary loops.
 *  8. Apply small-shell removal, if enabled.
 *  9. Run ONE bounded final cleanup pass (degenerate + duplicate removal
 *     again) — welding or hole-filling can introduce new degenerate/
 *     duplicate geometry; this is a single, fixed, documented second
 *     pass, never a loop that repeats "until it looks clean."
 * 10. Serialize a binary STL from the repaired geometry (normals always
 *     recomputed from the repaired triangles — the original file's own
 *     stored normals are never reused).
 * 11. Re-parse that exact serialized output — never the in-memory
 *     geometry — and run diagnostics on IT. This is what makes "fully
 *     repaired" an evidence-based claim: it can only ever be true when
 *     the bytes actually written to the output file verify clean.
 * 12. Determine the outcome (`outcome.ts`) and assemble the full result.
 *
 * Every stage receives and returns a flat position buffer; none of them
 * mutate the buffer they were given.
 */
import { parseSTL } from "../stl/parse";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { DEFAULT_STL_LIMITS } from "../stl/types";
import { analyzeSTLDiagnostics } from "../stl-diagnostics/analyze";
import { summarizeDiagnostics, type RepairLimits, type RepairOperation, type RepairResult, type RepairSettings, type RepairStageTiming, type SkippedOperation } from "./types";
import { planRepair } from "./plan";
import { weldVertices } from "./weld";
import { removeDegenerateTriangles, removeDuplicateFaces } from "./cleanup";
import { correctWinding } from "./winding";
import { fillHoles } from "./hole-fill";
import { removeSmallShells } from "./shell-cleanup";
import { determineOutcome } from "./outcome";
import { buildRepairOverlayBuffers } from "./overlays";
import { repairError } from "./errors";

export interface RepairPipelineOptions {
  isCancelled?: () => boolean;
  onProgress?: (stage: string) => void;
}

const STAGES = {
  checkingOriginal: "checking-original-mesh",
  planning: "planning-repairs",
  welding: "welding-vertices",
  removingInvalid: "removing-invalid-faces",
  correctingWinding: "correcting-winding",
  fillingHoles: "filling-holes",
  cleaningShells: "cleaning-shells",
  writingOutput: "writing-repaired-stl",
  verifyingOutput: "verifying-repaired-stl",
  preparingComparison: "preparing-comparison",
} as const;

export async function repairSTL(originalPositions: Float32Array, settings: RepairSettings, limits: RepairLimits, options: RepairPipelineOptions = {}): Promise<RepairResult> {
  const stageTimings: RepairStageTiming[] = [];
  const warnings: { code: string; message: string }[] = [];
  const attemptedOperations: RepairOperation[] = [];
  const successfulOperations: RepairOperation[] = [];
  const skippedOperations: SkippedOperation[] = [];
  const unresolvedProblems: string[] = [];

  async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    options.onProgress?.(name);
    if (options.isCancelled?.()) throw repairError("STLREPAIR_PLANNING_FAILED");
    const t0 = Date.now();
    const result = await fn();
    stageTimings.push({ stage: name, durationMs: Date.now() - t0 });
    return result;
  }

  const originalDiagnostics = await stage(STAGES.checkingOriginal, () => analyzeSTLDiagnostics(originalPositions, limits.diagnostics, { isCancelled: options.isCancelled }));
  if (originalDiagnostics.validTriangleCount === 0) throw repairError("STLREPAIR_NO_VALID_TRIANGLES");

  const plan = await stage(STAGES.planning, () => planRepair(originalDiagnostics, settings));

  let positions = originalPositions;
  let verticesWelded = 0;
  let collapsedByWelding = 0;
  let repeatedVertexRemoved = 0;
  let exactZeroAreaRemoved = 0;
  let nearZeroAreaRemoved = 0;
  let sameWindingDuplicateRemoved = 0;
  let reverseWindingDuplicateRemoved = 0;
  let trianglesFlipped = 0;
  let shellsReversed = 0;
  let holesFilled = 0;
  let trianglesAdded = 0;
  let shellsRemoved = 0;

  await stage(STAGES.welding, async () => {
    if (!settings.weld.enabled) return;
    attemptedOperations.push("weld-vertices");
    if (settings.weld.toleranceAbs < limits.minToleranceAbs) throw repairError("STLREPAIR_UNSAFE_TOLERANCE");
    const diagonal = boundsDiagonal(positions);
    if (diagonal > 0 && settings.weld.toleranceAbs > diagonal * limits.maxToleranceRatio) throw repairError("STLREPAIR_UNSAFE_TOLERANCE");

    const result = await weldVertices(positions, settings.weld.toleranceAbs, { maxWeldCandidates: limits.maxWeldCandidates, maxWeldGridCells: limits.maxWeldGridCells }, { isCancelled: options.isCancelled });
    positions = result.positions;
    verticesWelded = result.verticesWelded;
    collapsedByWelding = result.trianglesCollapsed;
    if (verticesWelded > 0 || collapsedByWelding > 0) successfulOperations.push("weld-vertices");
  });

  await stage(STAGES.removingInvalid, async () => {
    if (settings.removeExactDegenerates || settings.removeNearZeroDegenerates) {
      attemptedOperations.push("remove-repeated-vertex-triangles", "remove-exact-zero-area-triangles");
      if (settings.removeNearZeroDegenerates) attemptedOperations.push("remove-near-zero-area-triangles");
      const result = await removeDegenerateTriangles(positions, { removeExact: settings.removeExactDegenerates, removeNearZero: settings.removeNearZeroDegenerates, isCancelled: options.isCancelled });
      positions = result.positions;
      repeatedVertexRemoved += result.repeatedVertexRemoved;
      exactZeroAreaRemoved += result.exactZeroAreaRemoved;
      nearZeroAreaRemoved += result.nearZeroAreaRemoved;
      if (result.repeatedVertexRemoved > 0 || result.exactZeroAreaRemoved > 0) successfulOperations.push("remove-repeated-vertex-triangles", "remove-exact-zero-area-triangles");
      if (result.nearZeroAreaRemoved > 0) successfulOperations.push("remove-near-zero-area-triangles");
    }
    if (settings.removeDuplicateFaces) {
      attemptedOperations.push("remove-same-winding-duplicate-faces", "remove-reverse-winding-duplicate-faces");
      const result = await removeDuplicateFaces(positions, { isCancelled: options.isCancelled });
      positions = result.positions;
      sameWindingDuplicateRemoved += result.sameWindingRemoved;
      reverseWindingDuplicateRemoved += result.reverseWindingRemoved;
      if (result.sameWindingRemoved > 0) successfulOperations.push("remove-same-winding-duplicate-faces");
      if (result.reverseWindingRemoved > 0) successfulOperations.push("remove-reverse-winding-duplicate-faces");
    }
  });

  // Snapshot for the "removed triangles" / "welded vertices" overlays —
  // taken right after welding + degenerate/duplicate cleanup, before any
  // winding/hole-fill/shell-removal stage can further change the mesh.
  const positionsAfterCleanup = positions;

  await stage(STAGES.correctingWinding, async () => {
    if (!settings.correctWinding && !settings.orientOutwardClosedShells) return;
    attemptedOperations.push("correct-winding");
    if (settings.orientOutwardClosedShells) attemptedOperations.push("orient-outward-closed-shells");
    const result = await correctWinding(positions, { orientOutwardClosedShells: settings.orientOutwardClosedShells, isCancelled: options.isCancelled });
    positions = result.positions;
    trianglesFlipped = result.trianglesFlipped;
    shellsReversed = result.shellsReversed;
    if (trianglesFlipped > 0) successfulOperations.push("correct-winding");
    if (shellsReversed > 0) successfulOperations.push("orient-outward-closed-shells");
    if (result.unresolvedShellCount > 0) unresolvedProblems.push(`${result.unresolvedShellCount} shell(s) could not be consistently oriented (a genuine topological contradiction) and were left unchanged.`);
  });
  const positionsAfterWinding = positions;

  let holeSkips: import("./types").HoleFillSkip[] = [];
  let holeFillPatchPositions = new Float32Array(0);
  await stage(STAGES.fillingHoles, async () => {
    if (!settings.fillEligibleHoles) return;
    attemptedOperations.push("fill-eligible-holes");
    const result = await fillHoles(
      positions,
      { maxLoopVertexCount: limits.maxLoopVertexCount, maxLoopPerimeterRatio: limits.maxLoopPerimeterRatio, maxLoopAreaRatio: limits.maxLoopAreaRatio, maxPatchTrianglesPerLoop: limits.maxPatchTrianglesPerLoop, maxHolesFilled: limits.maxHolesFilled },
      { isCancelled: options.isCancelled },
    );
    // fillHoles() always APPENDS new patch triangles after the original
    // survivors, so the tail slice beyond the pre-fill length is exactly
    // (and only) the newly added geometry — no diffing needed.
    holeFillPatchPositions = result.positions.slice(positions.length);
    positions = result.positions;
    holesFilled = result.filledLoopCount;
    trianglesAdded = result.trianglesAdded;
    holeSkips = result.skips;
    if (holesFilled > 0) successfulOperations.push("fill-eligible-holes");
    for (const skip of result.skips) {
      if (skip.reason !== "not-a-closed-loop") {
        unresolvedProblems.push(`Boundary component ${skip.boundaryComponentId} could not be safely filled (${skip.reason}) and was left as-is.`);
      }
    }
  });

  let removedShellPositions: Float32Array = new Float32Array(0);
  await stage(STAGES.cleaningShells, async () => {
    if (settings.removeSmallShells.enabled) {
      attemptedOperations.push("remove-small-shells");
      const result = await removeSmallShells(positions, { criterion: settings.removeSmallShells.criterion, threshold: settings.removeSmallShells.threshold, maxShellsConsidered: limits.maxShellsConsideredForRemoval, isCancelled: options.isCancelled });
      positions = result.positions;
      shellsRemoved = result.shellsRemoved.length;
      removedShellPositions = result.removedPositions;
      if (shellsRemoved > 0) successfulOperations.push("remove-small-shells");
    }

    // One bounded, documented final cleanup pass of degenerate/duplicate
    // removal — ALWAYS runs here (not gated behind small-shell removal),
    // since welding, hole-filling and small-shell removal can each
    // introduce new degenerate or duplicate geometry (e.g. filling a
    // lone triangle's own trivially-closed 3-edge boundary would
    // otherwise leave an exact duplicate behind). A single fixed pass,
    // never a loop that repeats until results "look good."
    if (settings.removeExactDegenerates || settings.removeNearZeroDegenerates) {
      const cleanupResult = await removeDegenerateTriangles(positions, { removeExact: settings.removeExactDegenerates, removeNearZero: settings.removeNearZeroDegenerates, isCancelled: options.isCancelled });
      positions = cleanupResult.positions;
      repeatedVertexRemoved += cleanupResult.repeatedVertexRemoved;
      exactZeroAreaRemoved += cleanupResult.exactZeroAreaRemoved;
      nearZeroAreaRemoved += cleanupResult.nearZeroAreaRemoved;
    }
    if (settings.removeDuplicateFaces) {
      const dupResult = await removeDuplicateFaces(positions, { isCancelled: options.isCancelled });
      positions = dupResult.positions;
      sameWindingDuplicateRemoved += dupResult.sameWindingRemoved;
      reverseWindingDuplicateRemoved += dupResult.reverseWindingRemoved;
    }
  });

  if (positions.length / 9 > limits.maxOutputTriangles) throw repairError("STLREPAIR_TOPOLOGY_LIMIT_EXCEEDED");

  const outputBytes = await stage(STAGES.writingOutput, () => {
    try {
      // `normals` deliberately omitted — always recomputed from the
      // repaired geometry, never trusting the original file's stored
      // normals, which may no longer even correspond to the repaired
      // triangle winding.
      const bytes = serializeBinarySTL({ positions, header: "MeshWrench repaired STL" });
      if (bytes.byteLength > limits.maxOutputBytes) throw repairError("STLREPAIR_OUTPUT_SIZE_LIMIT_EXCEEDED");
      return bytes;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw repairError("STLREPAIR_SERIALIZATION_FAILED");
    }
  });

  const { afterDiagnostics } = await stage(STAGES.verifyingOutput, async () => {
    let reparsedResult;
    try {
      reparsedResult = parseSTL(outputBytes, DEFAULT_STL_LIMITS);
    } catch {
      throw repairError("STLREPAIR_OUTPUT_REPARSE_FAILED");
    }
    let diagnosticsResult;
    try {
      diagnosticsResult = await analyzeSTLDiagnostics(reparsedResult.positions, limits.diagnostics, { isCancelled: options.isCancelled });
    } catch {
      throw repairError("STLREPAIR_VERIFICATION_FAILED");
    }
    return { afterDiagnostics: diagnosticsResult };
  });

  const result = await stage(STAGES.preparingComparison, () => {
    const before = summarizeDiagnostics(originalDiagnostics);
    const after = summarizeDiagnostics(afterDiagnostics);
    if (afterDiagnostics.selfIntersections.status === "not-checked") {
      warnings.push({ code: "self-intersections-not-verified", message: "The repaired model's self-intersection check couldn't complete within this tool's safety limits — the result cannot claim all geometry problems are resolved." });
    }

    // Explicit, honest problem reporting for defects this phase never
    // attempts an operation against directly (non-manifold edges beyond
    // what duplicate/degenerate cleanup incidentally resolves, and
    // self-intersections, which are detect-only this phase) — the raw
    // counts already appear in the comparison table, but an unresolved
    // topology issue should also be named explicitly, not left implicit.
    if (after.nonManifoldEdgeCount > 0) {
      unresolvedProblems.push(`${after.nonManifoldEdgeCount} non-manifold edge(s) remain — no safe deterministic fix was identified, and this phase never deletes arbitrary triangles to force one.`);
    }
    if (after.selfIntersectionStatus === "completed" && after.selfIntersectionCount > 0) {
      unresolvedProblems.push(`${after.selfIntersectionCount} self-intersecting triangle pair(s) remain — self-intersection resolution is detect-only in this phase.`);
    }

    const outcome = determineOutcome({ before, after, skippedOperations, unresolvedProblems });

    const overlays = buildRepairOverlayBuffers(
      { originalPositions, positionsAfterCleanup, positionsBeforeWinding: positionsAfterCleanup, positionsAfterWinding, holeFillPatchPositions, removedShellPositions },
      afterDiagnostics,
      limits.maxOverlaySamplesPerCategory,
    );

    const finalResult: RepairResult = {
      outcome,
      plan,
      before,
      after,
      attemptedOperations: [...new Set(attemptedOperations)],
      successfulOperations: [...new Set(successfulOperations)],
      skippedOperations,
      unresolvedProblems,
      holeFillSkips: holeSkips,
      verticesBefore: originalDiagnostics.uniqueVertexPositionCount,
      verticesAfter: afterDiagnostics.uniqueVertexPositionCount,
      trianglesBefore: originalDiagnostics.triangleCount,
      trianglesAfter: afterDiagnostics.triangleCount,
      verticesWelded,
      trianglesRemovedByCategory: {
        repeatedVertex: repeatedVertexRemoved,
        exactZeroArea: exactZeroAreaRemoved,
        nearZeroArea: nearZeroAreaRemoved,
        collapsedByWelding,
        sameWindingDuplicate: sameWindingDuplicateRemoved,
        reverseWindingDuplicate: reverseWindingDuplicateRemoved,
      },
      trianglesFlipped,
      shellsReversed,
      holesFilled,
      trianglesAdded,
      shellsRemoved,
      nonManifoldEdgesBefore: originalDiagnostics.nonManifoldEdgeCount,
      nonManifoldEdgesAfter: afterDiagnostics.nonManifoldEdgeCount,
      boundaryEdgesBefore: originalDiagnostics.boundaryEdgeCount,
      boundaryEdgesAfter: afterDiagnostics.boundaryEdgeCount,
      windingConflictsBefore: originalDiagnostics.windingConflictEdgeCount,
      windingConflictsAfter: afterDiagnostics.windingConflictEdgeCount,
      selfIntersectionStatusBefore: originalDiagnostics.selfIntersections.status,
      selfIntersectionStatusAfter: afterDiagnostics.selfIntersections.status,
      watertightVerdictBefore: originalDiagnostics.verdict,
      watertightVerdictAfter: afterDiagnostics.verdict,
      outputBytes,
      overlays,
      stageTimings,
      warnings,
    };
    return finalResult;
  });

  return result;
}

function boundsDiagonal(positions: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}
