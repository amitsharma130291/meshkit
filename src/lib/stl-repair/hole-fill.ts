/**
 * Conservative hole filling. Only ever fills a boundary component Phase
 * 5's own `analyzeBoundaryComponents()` classified as `"closed-loop"` —
 * an open chain, a branched junction or a non-simple component is never
 * treated as fillable, since none of them is provably a simple hole.
 *
 * Triangulation itself is NOT reimplemented here: once a closed loop's
 * ordered vertex sequence is walked (the one piece of information a
 * diagnostics-only classification never needs to keep, so this module
 * derives it locally from the same `BoundaryComponent.edges` Phase 5
 * already computed), the loop is handed directly to
 * `mesh/triangulate.ts`'s existing, already-tested `triangulatePolygon()`
 * — the exact same Newell-plane estimation, planarity-deviation
 * rejection, convex/fan-vs-ear-clip choice and self-intersecting-
 * boundary rejection the OBJ and PLY writers already rely on. This
 * module's own job is: walk the loop, apply the size/perimeter/area
 * ceilings below (checked BEFORE triangulation is attempted), orient the
 * resulting patch to agree with the surrounding surface's own winding,
 * and apply the patch-triangle-count ceiling to the result.
 */
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { analyzeBoundaryComponents, type BoundaryComponent } from "../mesh/boundary-components";
import { triangulatePolygon } from "../mesh/triangulate";
import { FaceTooSmallError, PolygonDegenerateError, PolygonNonPlanarError, PolygonSelfIntersectingError, TriangulationFailedError } from "../mesh/errors";
import { yieldIfCancelled } from "../cancellation";
import type { HoleFillSkip } from "./types";

export interface HoleFillOptions {
  isCancelled?: () => boolean;
}

export interface HoleFillLimits {
  maxLoopVertexCount: number;
  maxLoopPerimeterRatio: number;
  maxLoopAreaRatio: number;
  maxPatchTrianglesPerLoop: number;
  maxHolesFilled: number;
}

export interface HoleFillResult {
  positions: Float32Array;
  eligibleLoopCount: number;
  filledLoopCount: number;
  trianglesAdded: number;
  skips: HoleFillSkip[];
}

const MAX_TRIANGULATION_ITERATIONS = 10_000;

export async function fillHoles(positions: Float32Array, limits: HoleFillLimits, options: HoleFillOptions = {}): Promise<HoleFillResult> {
  const mesh = await buildCanonicalMesh(positions, { maxUniqueVertices: Number.MAX_SAFE_INTEGER }, { isCancelled: options.isCancelled });
  const edgeIncidence = buildEdgeIncidence(mesh.validTriangles, { maxEdgeRecords: Number.MAX_SAFE_INTEGER });
  const boundary = analyzeBoundaryComponents(edgeIncidence.edgesByKey, { maxComponents: Number.MAX_SAFE_INTEGER, maxSampleVerticesPerComponent: 1 });

  const diagonal = Math.hypot(mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[1] - mesh.bounds.min[1], mesh.bounds.max[2] - mesh.bounds.min[2]);
  const maxPerimeter = diagonal * limits.maxLoopPerimeterRatio;
  const maxArea = diagonal * diagonal * limits.maxLoopAreaRatio;

  const closedLoops = boundary.components.filter((c) => c.kind === "closed-loop");
  const skips: HoleFillSkip[] = [];
  for (const c of boundary.components) {
    if (c.kind !== "closed-loop") skips.push({ boundaryComponentId: c.id, reason: "not-a-closed-loop" });
  }

  const patchPositions: number[] = [];
  let filledLoopCount = 0;
  let trianglesAdded = 0;

  for (let i = 0; i < closedLoops.length; i++) {
    await yieldIfCancelled(i, 200, options.isCancelled);
    const component = closedLoops[i];

    if (filledLoopCount >= limits.maxHolesFilled) {
      skips.push({ boundaryComponentId: component.id, reason: "hole-count-limit" });
      continue;
    }
    if (component.vertexCount > limits.maxLoopVertexCount) {
      skips.push({ boundaryComponentId: component.id, reason: "vertex-count-limit" });
      continue;
    }

    const loop = walkClosedLoop(component);
    if (!loop) {
      skips.push({ boundaryComponentId: component.id, reason: "not-a-closed-loop" });
      continue;
    }

    const loopPoints: [number, number, number][] = loop.map((id) => [mesh.vertices[id * 3], mesh.vertices[id * 3 + 1], mesh.vertices[id * 3 + 2]]);

    const perimeter = loopPerimeter(loopPoints);
    if (perimeter > maxPerimeter) {
      skips.push({ boundaryComponentId: component.id, reason: "perimeter-limit" });
      continue;
    }
    const area = newellAreaMagnitude(loopPoints);
    if (area > maxArea) {
      skips.push({ boundaryComponentId: component.id, reason: "area-limit" });
      continue;
    }

    const orientedLoop = matchSurroundingWinding(loop, edgeIncidence.edgesByKey);
    const orientedPoints: [number, number, number][] = orientedLoop.map((id) => [mesh.vertices[id * 3], mesh.vertices[id * 3 + 1], mesh.vertices[id * 3 + 2]]);

    let triangleIndexTriples: [number, number, number][];
    try {
      triangleIndexTriples = triangulatePolygon(orientedPoints, MAX_TRIANGULATION_ITERATIONS).triangles;
    } catch (error) {
      if (error instanceof PolygonNonPlanarError) skips.push({ boundaryComponentId: component.id, reason: "planarity-limit" });
      else if (error instanceof PolygonSelfIntersectingError) skips.push({ boundaryComponentId: component.id, reason: "self-intersecting-boundary" });
      else if (error instanceof PolygonDegenerateError || error instanceof FaceTooSmallError || error instanceof TriangulationFailedError) {
        skips.push({ boundaryComponentId: component.id, reason: "triangulation-failed" });
      } else {
        throw error;
      }
      continue;
    }

    if (triangleIndexTriples.length > limits.maxPatchTrianglesPerLoop) {
      skips.push({ boundaryComponentId: component.id, reason: "patch-triangle-limit" });
      continue;
    }

    for (const [ia, ib, ic] of triangleIndexTriples) {
      for (const idx of [ia, ib, ic]) {
        const [x, y, z] = orientedPoints[idx];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          skips.push({ boundaryComponentId: component.id, reason: "triangulation-failed" });
          continue;
        }
        patchPositions.push(x, y, z);
      }
    }
    filledLoopCount++;
    trianglesAdded += triangleIndexTriples.length;
  }

  const basePositions = rebuildFromTriangles(mesh.validTriangles, mesh.vertices);
  const combined = new Float32Array(basePositions.length + patchPositions.length);
  combined.set(basePositions, 0);
  combined.set(Float32Array.from(patchPositions), basePositions.length);

  return { positions: combined, eligibleLoopCount: closedLoops.length, filledLoopCount, trianglesAdded, skips };
}

/** Walks a closed-loop component's own edges into an ordered cyclic vertex sequence — the one piece of information Phase 5's classification-only analysis never needs to preserve. Every vertex has boundary-degree exactly 2 (guaranteed by `"closed-loop"` classification), so at each step there is exactly one unvisited edge to follow. */
function walkClosedLoop(component: BoundaryComponent): number[] | null {
  const edgesByVertex = new Map<number, { a: number; b: number; key: string }[]>();
  for (const e of component.edges) {
    if (!edgesByVertex.has(e.a)) edgesByVertex.set(e.a, []);
    if (!edgesByVertex.has(e.b)) edgesByVertex.set(e.b, []);
    edgesByVertex.get(e.a)!.push(e);
    edgesByVertex.get(e.b)!.push(e);
  }

  const start = component.edges[0]?.a;
  if (start === undefined) return null;
  const order: number[] = [start];
  let previousKey: string | null = null;
  let current = start;

  for (let step = 0; step < component.edgeCount; step++) {
    const candidates = edgesByVertex.get(current) ?? [];
    const next = candidates.find((e) => e.key !== previousKey);
    if (!next) return null;
    const other = next.a === current ? next.b : next.a;
    previousKey = next.key;
    current = other;
    if (current === start) break;
    order.push(current);
  }

  return order.length === component.vertexCount ? order : null;
}

function loopPerimeter(points: readonly [number, number, number][]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

/** Half the magnitude of the Newell sum — a standard planar(ish)-polygon area estimate, stable even for a near-degenerate or slightly non-planar loop. */
function newellAreaMagnitude(points: readonly [number, number, number][]): number {
  let nx = 0, ny = 0, nz = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1, z1] = points[i];
    const [x2, y2, z2] = points[(i + 1) % n];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

/**
 * Reverses the walked loop order when needed so the resulting patch
 * traverses its shared boundary edges OPPOSITE to how the single
 * existing adjacent triangle already traverses them — the same
 * "opposite direction = consistent winding" rule `edge-incidence.ts`
 * itself defines. Never guesses: reads the one recorded directed use of
 * the loop's own first edge.
 */
function matchSurroundingWinding(loop: readonly number[], edgesByKey: ReadonlyMap<string, { uses: { from: number; to: number }[] }>): number[] {
  const a = loop[0];
  const b = loop[1];
  const key = a < b ? `${a}_${b}` : `${b}_${a}`;
  const edge = edgesByKey.get(key);
  const existingUse = edge?.uses[0];
  if (!existingUse) return [...loop];
  // Our loop currently traverses a -> b. If the existing triangle ALSO
  // traverses a -> b, the patch must be reversed to run opposite to it.
  const existingGoesAtoB = existingUse.from === a;
  return existingGoesAtoB ? [...loop].reverse() : [...loop];
}

function rebuildFromTriangles(triangles: readonly { vertexIds: readonly [number, number, number] }[], vertices: Float32Array): Float32Array {
  const out = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const tri of triangles) {
    for (const v of tri.vertexIds) {
      out[offset++] = vertices[v * 3];
      out[offset++] = vertices[v * 3 + 1];
      out[offset++] = vertices[v * 3 + 2];
    }
  }
  return out;
}
