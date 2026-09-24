/**
 * The STL Diagnostics orchestrator: runs the full mesh-topology pipeline
 * (`src/lib/mesh/*`) over an already-parsed STL position buffer and
 * assembles the final `STLDiagnosticsReport`. This module never parses
 * STL bytes itself — `src/workers/stl-diagnostics.worker.ts` calls the
 * existing `parseSTL()` first, exactly like every other STL-consuming
 * worker, and hands this module only the resulting `positions` buffer.
 *
 * Cancellation: every stage boundary is checked (matching every other
 * worker's own "cancel between named stages" convention). Additionally,
 * two stages get their OWN mid-loop cancellation, since they are the only
 * two whose cost isn't already implicitly bounded by a single O(triangle
 * count) pass: vertex deduplication (`canonical-vertices.ts`, via the
 * existing `deduplicateVertices` cancellation support) and self-
 * intersection narrow-phase testing (`triangle-intersections.ts`, added
 * this phase). This is a deliberate, disclosed scope decision — the
 * other stages (edge incidence, boundary components, shells, orientation,
 * duplicate faces) are each already bounded by this report's own vertex/
 * edge/group ceilings and, in practice, complete in well under a video
 * frame even for multi-million-triangle meshes; see the Phase 5
 * completion report for the full reasoning.
 *
 * Work-budget policy: `limits.maxAnalysisMs` is checked at each stage
 * boundary. If exceeded before the (mandatory) core topology stages
 * finish, analysis fails outright (`STLDiagnosticsBudgetExceededError` —
 * there is no way to produce a meaningful report without them). If
 * exceeded only once every core stage has already finished, the
 * self-intersection check (the one genuinely open-ended stage) is
 * skipped and honestly reported `"not-checked"` rather than run over
 * budget — the same "skip and disclose, never claim pass" policy this
 * phase applies to every other safety ceiling.
 */
import { yieldIfCancelled } from "../cancellation";
import { buildCanonicalMesh, type CanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { analyzeBoundaryComponents } from "../mesh/boundary-components";
import { resolveTriangleShells } from "../mesh/connected-components";
import { analyzeShellOrientation } from "../mesh/orientation";
import { analyzeDuplicateFaces, type DuplicateFaceGroup } from "../mesh/duplicate-faces";
import { analyzeSelfIntersections } from "../mesh/triangle-intersections";
import type { CanonicalTriangle } from "../mesh/topology-types";
import { STLDiagnosticsBudgetExceededError } from "./errors";
import { computeSlicerRisk, computeVerdict } from "./verdict";
import type {
  BoundaryComponentSummary,
  DiagnosticsOverlayBuffers,
  DiagnosticsWarning,
  STLDiagnosticsLimits,
  STLDiagnosticsReport,
  STLDiagnosticsStageTiming,
  ShellSummary,
} from "./types";

export interface AnalyzeSTLDiagnosticsOptions {
  isCancelled?: () => boolean;
  onProgress?: (stage: string) => void;
}

const STAGES = {
  buildingTopology: "building-topology",
  checkingTriangles: "checking-triangles",
  classifyingEdges: "classifying-edges",
  findingBoundaryComponents: "finding-boundary-components",
  resolvingShells: "resolving-shells",
  checkingOrientation: "checking-orientation",
  buildingSpatialIndex: "building-spatial-index",
  checkingIntersections: "checking-intersections",
  preparingReport: "preparing-report",
} as const;

export async function analyzeSTLDiagnostics(positions: Float32Array, limits: STLDiagnosticsLimits, options: AnalyzeSTLDiagnosticsOptions = {}): Promise<STLDiagnosticsReport> {
  const overallStart = Date.now();
  const stageTimings: STLDiagnosticsStageTiming[] = [];
  const warnings: DiagnosticsWarning[] = [];

  async function enterStage(name: string, mandatory: boolean): Promise<number> {
    options.onProgress?.(name);
    await yieldIfCancelled(0, 1, options.isCancelled);
    if (mandatory && Date.now() - overallStart > limits.maxAnalysisMs) {
      throw new STLDiagnosticsBudgetExceededError();
    }
    return Date.now();
  }
  function leaveStage(name: string, startedAt: number): void {
    stageTimings.push({ stage: name, durationMs: Date.now() - startedAt });
  }

  let t = await enterStage(STAGES.buildingTopology, true);
  const mesh: CanonicalMesh = await buildCanonicalMesh(positions, { maxUniqueVertices: limits.maxUniqueVertices }, { isCancelled: options.isCancelled });
  leaveStage(STAGES.buildingTopology, t);

  // Degenerate classification already happened inside buildCanonicalMesh
  // (it's cheap and inseparable from building the vertex list itself);
  // this stage exists as its own named, timed, reported step because the
  // task's own progress-stage list calls it out distinctly.
  t = await enterStage(STAGES.checkingTriangles, true);
  leaveStage(STAGES.checkingTriangles, t);

  t = await enterStage(STAGES.classifyingEdges, true);
  const edgeIncidence = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: limits.maxEdgeRecords });
  leaveStage(STAGES.classifyingEdges, t);

  t = await enterStage(STAGES.findingBoundaryComponents, true);
  const boundary = analyzeBoundaryComponents(edgeIncidence.edgesByKey, { maxComponents: limits.maxBoundaryComponents, maxSampleVerticesPerComponent: limits.maxSampleVerticesPerBoundaryComponent });
  leaveStage(STAGES.findingBoundaryComponents, t);

  t = await enterStage(STAGES.resolvingShells, true);
  const shells = resolveTriangleShells(mesh.validTriangles, edgeIncidence.edgesByKey);
  leaveStage(STAGES.resolvingShells, t);

  t = await enterStage(STAGES.checkingOrientation, true);
  const trianglesByIndex = new Map<number, CanonicalTriangle>(mesh.validTriangles.map((tri) => [tri.index, tri]));
  const shellSummaries: ShellSummary[] = [];
  const detailedShellCount = Math.min(shells.shellCount, limits.maxDetailedShells);
  let inwardShellCount = 0;
  let totalSurfaceArea = 0;
  let totalEnclosedVolume: number | null = null;
  let anyVolumeCounted = false;

  for (let shellId = 0; shellId < shells.shellCount; shellId++) {
    await yieldIfCancelled(shellId, 500, options.isCancelled);
    const triangleIndices = shells.triangleIndicesByShell[shellId];
    const orientation = analyzeShellOrientation(shellId, triangleIndices, trianglesByIndex, edgeIncidence.edgesByKey, mesh.vertices);
    const area = shellSurfaceArea(triangleIndices, trianglesByIndex, mesh.vertices);
    totalSurfaceArea += area;
    if (orientation.verdict === "inward") inwardShellCount++;
    if (orientation.closed && orientation.consistentlyOrientable && orientation.verdict !== "indeterminate") {
      totalEnclosedVolume = (totalEnclosedVolume ?? 0) + orientation.signedVolume;
      anyVolumeCounted = true;
    }

    if (shellId < detailedShellCount) {
      shellSummaries.push({
        id: shellId,
        triangleCount: triangleIndices.length,
        bounds: shellBounds(triangleIndices, trianglesByIndex, mesh.vertices),
        surfaceArea: area,
        closed: orientation.closed,
        consistentlyOrientable: orientation.consistentlyOrientable,
        signedVolume: orientation.closed && orientation.consistentlyOrientable && orientation.verdict !== "indeterminate" ? orientation.signedVolume : null,
        orientation: orientation.verdict,
      });
    }
  }
  const shellsTruncated = shells.shellCount > limits.maxDetailedShells;
  if (shellsTruncated) warnings.push({ code: "shells-truncated", message: `Detailed information is shown for the first ${limits.maxDetailedShells} of ${shells.shellCount} shells.` });
  leaveStage(STAGES.checkingOrientation, t);

  t = await enterStage(STAGES.buildingSpatialIndex, true);
  const duplicates = analyzeDuplicateFaces(mesh.validTriangles, { maxGroups: limits.maxDuplicateFaceGroups, maxTriangleIndicesPerGroup: limits.maxTriangleIndicesPerDuplicateGroup });
  if (duplicates.truncated) warnings.push({ code: "duplicate-face-groups-truncated", message: `Only the first ${limits.maxDuplicateFaceGroups} duplicate-face groups are listed; the reported counts still reflect every group found.` });
  leaveStage(STAGES.buildingSpatialIndex, t);

  t = await enterStage(STAGES.checkingIntersections, false);
  const overBudget = Date.now() - overallStart > limits.maxAnalysisMs;
  const selfIntersections = overBudget
    ? { status: "not-checked" as const, intersectingPairCount: 0, involvedTriangleCount: 0, samplePairs: [] }
    : await analyzeSelfIntersections(
        mesh.validTriangles,
        mesh.vertices,
        edgeIncidence.edgesByKey,
        duplicates.groups,
        mesh.bounds,
        {
          targetTrianglesPerCell: limits.maxSpatialIndexTargetTrianglesPerCell,
          maxGridCells: limits.maxSpatialIndexGridCells,
          maxCandidatePairs: limits.maxCandidateIntersectionPairs,
          maxSamplePairs: limits.maxSelfIntersectionSamplePairs,
        },
        { isCancelled: options.isCancelled },
      );
  if (overBudget) warnings.push({ code: "self-intersections-skipped-budget", message: "Self-intersection checking was skipped because this model exceeded the checker's time budget; every other check above still completed." });
  else if (selfIntersections.status === "not-checked") warnings.push({ code: "self-intersections-skipped-limit", message: "Self-intersection checking was skipped because this model exceeded the checker's complexity safety limit; every other check above still completed." });
  leaveStage(STAGES.checkingIntersections, t);

  t = await enterStage(STAGES.preparingReport, true);

  const boundaryComponents: BoundaryComponentSummary[] = boundary.components.map((c) => ({ id: c.id, kind: c.kind, edgeCount: c.edgeCount, vertexCount: c.vertexCount }));
  if (boundary.totalBoundaryEdges > 0 && boundary.components.length < countRealComponents(boundary)) {
    warnings.push({ code: "boundary-components-truncated", message: `Detailed information is shown for the first ${limits.maxBoundaryComponents} boundary components; the reported edge/loop counts still reflect the full file.` });
  }

  const { verdict, reasonCodes } = computeVerdict({
    validTriangleCount: mesh.validTriangles.length,
    boundaryEdgeCount: edgeIncidence.boundaryEdgeCount,
    nonManifoldEdgeCount: edgeIncidence.nonManifoldEdgeCount,
    windingConflictEdgeCount: edgeIncidence.windingConflictEdgeCount,
    sameWindingDuplicateFaceCount: duplicates.sameWindingDuplicateFaceCount,
    reverseWindingDuplicateFaceCount: duplicates.reverseWindingDuplicateFaceCount,
    selfIntersections,
  });

  const report: STLDiagnosticsReport = {
    verdict,
    reasonCodes,
    slicerRisk: [],

    triangleCount: mesh.triangleCount,
    validTriangleCount: mesh.validTriangles.length,
    degenerateTriangleCount: mesh.degenerate.length,
    repeatedVertexTriangleCount: mesh.repeatedVertexCount,
    exactZeroAreaTriangleCount: mesh.exactZeroAreaCount,
    nearZeroAreaTriangleCount: mesh.nearZeroAreaCount,

    sourceVertexSlotCount: mesh.sourceVertexCount,
    uniqueVertexPositionCount: mesh.uniqueVertexCount,
    duplicateCoordinateReferenceCount: mesh.duplicateCoordinateReferenceCount,

    sameWindingDuplicateFaceCount: duplicates.sameWindingDuplicateFaceCount,
    reverseWindingDuplicateFaceCount: duplicates.reverseWindingDuplicateFaceCount,
    duplicateFaceGroupCount: duplicates.groups.length,
    duplicateFaceGroupsTruncated: duplicates.truncated,

    boundaryEdgeCount: boundary.totalBoundaryEdges,
    boundaryComponents,
    boundaryComponentsTruncated: boundary.totalBoundaryEdges > 0 && boundaryComponents.length < boundary.closedLoopCount + boundary.openChainCount + boundary.branchedCount + boundary.nonSimpleCount,
    closedLoopBoundaryCount: boundary.closedLoopCount,
    openChainBoundaryCount: boundary.openChainCount,
    branchedBoundaryCount: boundary.branchedCount,
    nonSimpleBoundaryCount: boundary.nonSimpleCount,

    manifoldEdgeCount: edgeIncidence.manifoldEdgeCount,
    nonManifoldEdgeCount: edgeIncidence.nonManifoldEdgeCount,
    windingConflictEdgeCount: edgeIncidence.windingConflictEdgeCount,

    shellCount: shells.shellCount,
    shells: shellSummaries,
    shellsTruncated,
    inwardShellCount,

    selfIntersections,

    bounds: mesh.bounds,
    surfaceArea: totalSurfaceArea,
    totalEnclosedVolume: anyVolumeCounted ? totalEnclosedVolume : null,

    stageTimings,
    warnings,
    overlays: buildOverlayBuffers(mesh, edgeIncidence, duplicates.groups, selfIntersections, shells, trianglesByIndex, limits),
  };
  report.slicerRisk = computeSlicerRisk(report);

  leaveStage(STAGES.preparingReport, t);
  return report;
}

function countRealComponents(boundary: { closedLoopCount: number; openChainCount: number; branchedCount: number; nonSimpleCount: number }): number {
  return boundary.closedLoopCount + boundary.openChainCount + boundary.branchedCount + boundary.nonSimpleCount;
}

function shellSurfaceArea(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): number {
  let area = 0;
  for (const idx of triangleIndices) {
    const tri = trianglesByIndex.get(idx)!;
    area += triangleArea(tri, vertices);
  }
  return area;
}

function triangleArea(tri: CanonicalTriangle, vertices: Float32Array): number {
  const [ia, ib, ic] = tri.vertexIds;
  const ax = vertices[ia * 3], ay = vertices[ia * 3 + 1], az = vertices[ia * 3 + 2];
  const ux = vertices[ib * 3] - ax, uy = vertices[ib * 3 + 1] - ay, uz = vertices[ib * 3 + 2] - az;
  const vx = vertices[ic * 3] - ax, vy = vertices[ic * 3 + 1] - ay, vz = vertices[ic * 3 + 2] - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

function shellBounds(triangleIndices: readonly number[], trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>, vertices: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const idx of triangleIndices) {
    const tri = trianglesByIndex.get(idx)!;
    for (const vid of tri.vertexIds) {
      const x = vertices[vid * 3], y = vertices[vid * 3 + 1], z = vertices[vid * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function triangleCorners(tri: CanonicalTriangle, vertices: Float32Array, out: number[]): void {
  for (const vid of tri.vertexIds) {
    out.push(vertices[vid * 3], vertices[vid * 3 + 1], vertices[vid * 3 + 2]);
  }
}

function buildOverlayBuffers(
  mesh: CanonicalMesh,
  edgeIncidence: ReturnType<typeof buildEdgeIncidence>,
  duplicateGroups: readonly DuplicateFaceGroup[],
  selfIntersections: { samplePairs: { triangleA: number; triangleB: number }[] },
  shells: ReturnType<typeof resolveTriangleShells>,
  trianglesByIndex: ReadonlyMap<number, CanonicalTriangle>,
  limits: STLDiagnosticsLimits,
): DiagnosticsOverlayBuffers {
  const cap = limits.maxOverlaySamplesPerCategory;

  const boundaryEdgeLines: number[] = [];
  let boundaryTruncated = false;
  for (const edge of edgeIncidence.edgesByKey.values()) {
    if (edge.edgeClass !== "boundary") continue;
    if (boundaryEdgeLines.length / 6 >= cap) { boundaryTruncated = true; break; }
    pushEdgeLine(boundaryEdgeLines, edge.a, edge.b, mesh.vertices);
  }

  const nonManifoldEdgeLines: number[] = [];
  let nonManifoldTruncated = false;
  for (const edge of edgeIncidence.edgesByKey.values()) {
    if (edge.edgeClass !== "non-manifold") continue;
    if (nonManifoldEdgeLines.length / 6 >= cap) { nonManifoldTruncated = true; break; }
    pushEdgeLine(nonManifoldEdgeLines, edge.a, edge.b, mesh.vertices);
  }

  const windingConflictEdgeLines: number[] = [];
  let windingTruncated = false;
  for (const edge of edgeIncidence.edgesByKey.values()) {
    if (edge.windingConsistent) continue;
    if (windingConflictEdgeLines.length / 6 >= cap) { windingTruncated = true; break; }
    pushEdgeLine(windingConflictEdgeLines, edge.a, edge.b, mesh.vertices);
  }

  const degenerateTrianglePositions: number[] = [];
  let degenerateTruncated = false;
  for (const d of mesh.degenerate) {
    if (degenerateTrianglePositions.length / 9 >= cap) { degenerateTruncated = true; break; }
    const tri = mesh.triangles[d.index];
    triangleCorners(tri, mesh.vertices, degenerateTrianglePositions);
  }

  const duplicateFacePositions: number[] = [];
  let duplicateTruncated = false;
  outer: for (const group of duplicateGroups) {
    for (const idx of [...group.sameWindingTriangleIndices, ...group.reverseWindingTriangleIndices]) {
      if (duplicateFacePositions.length / 9 >= cap) { duplicateTruncated = true; break outer; }
      const tri = trianglesByIndex.get(idx);
      if (tri) triangleCorners(tri, mesh.vertices, duplicateFacePositions);
    }
  }

  const selfIntersectingTrianglePositions: number[] = [];
  let selfIntersectionTruncated = false;
  const seenIntersecting = new Set<number>();
  outerSi: for (const pair of selfIntersections.samplePairs) {
    for (const idx of [pair.triangleA, pair.triangleB]) {
      if (seenIntersecting.has(idx)) continue;
      if (selfIntersectingTrianglePositions.length / 9 >= cap) { selfIntersectionTruncated = true; break outerSi; }
      seenIntersecting.add(idx);
      const tri = trianglesByIndex.get(idx);
      if (tri) triangleCorners(tri, mesh.vertices, selfIntersectingTrianglePositions);
    }
  }

  const shellPositionsById: Record<number, Float32Array> = {};
  const shellCap = Math.min(shells.shellCount, limits.maxDetailedShells);
  for (let shellId = 0; shellId < shellCap; shellId++) {
    const out: number[] = [];
    for (const idx of shells.triangleIndicesByShell[shellId]) {
      const tri = trianglesByIndex.get(idx);
      if (tri) triangleCorners(tri, mesh.vertices, out);
    }
    shellPositionsById[shellId] = Float32Array.from(out);
  }

  return {
    boundaryEdgeLines: Float32Array.from(boundaryEdgeLines),
    nonManifoldEdgeLines: Float32Array.from(nonManifoldEdgeLines),
    windingConflictEdgeLines: Float32Array.from(windingConflictEdgeLines),
    degenerateTrianglePositions: Float32Array.from(degenerateTrianglePositions),
    duplicateFacePositions: Float32Array.from(duplicateFacePositions),
    selfIntersectingTrianglePositions: Float32Array.from(selfIntersectingTrianglePositions),
    shellPositionsById,
    truncated: {
      boundaryEdgeLines: boundaryTruncated,
      nonManifoldEdgeLines: nonManifoldTruncated,
      windingConflictEdgeLines: windingTruncated,
      degenerateTriangles: degenerateTruncated,
      duplicateFaces: duplicateTruncated,
      selfIntersectingTriangles: selfIntersectionTruncated,
      shells: shells.shellCount > shellCap,
    },
  };
}

function pushEdgeLine(out: number[], a: number, b: number, vertices: Float32Array): void {
  out.push(vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2], vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]);
}
