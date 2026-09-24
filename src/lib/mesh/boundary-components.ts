/**
 * Groups boundary edges (exactly one incident triangle — see
 * `edge-incidence.ts`) into connected components (two boundary edges are
 * adjacent when they share a vertex) and classifies each component's
 * shape. Every boundary edge belongs to exactly one component; a single
 * boundary edge is never, on its own, presented as "one hole" — this
 * module is what lets the diagnostics report say "3 boundary edges form
 * 1 closed loop" instead of just a raw edge count.
 *
 * Classification (a component's vertices, with `degree` = how many of the
 * component's own boundary edges touch that vertex):
 * - "closed-loop": every vertex has degree exactly 2, and the component
 *   forms a single simple cycle (edge count === vertex count). Reported
 *   as a "closed boundary loop" / "potential hole" — never a stronger,
 *   unprovable claim like "this is definitely a hole in an otherwise
 *   valid surface," since topology alone can't prove that.
 * - "open-chain": a simple path — exactly two vertices have degree 1 (the
 *   endpoints), every other vertex has degree 2, and edge count ===
 *   vertex count - 1.
 * - "branched": at least one vertex has degree 3 or more (a T/Y junction
 *   in the boundary — typically where a non-manifold edge meets the
 *   boundary).
 * - "non-simple": anything else (e.g. multiple disjoint cycles whose
 *   vertex sets happen to overlap in a way that isn't a clean branch) —
 *   an honest catch-all rather than forcing every shape into one of the
 *   three categories above.
 */
import type { CanonicalVertexId, EdgeRecord } from "./topology-types";

export type BoundaryComponentKind = "closed-loop" | "open-chain" | "branched" | "non-simple";

export interface BoundaryComponent {
  id: number;
  kind: BoundaryComponentKind;
  edgeCount: number;
  vertexCount: number;
  /** Bounded sample of this component's own vertex IDs — never every vertex for a very large boundary. */
  sampleVertexIds: CanonicalVertexId[];
  /**
   * This component's own COMPLETE edge list, unbounded — needed by
   * `stl-repair/hole-fill.ts` to walk a closed loop's ordered vertex
   * sequence for triangulation (classification alone, which is all a
   * diagnostics REPORT ever needs, doesn't preserve order). Diagnostics
   * reporting code should keep using the bounded fields above; this
   * field exists so hole-filling can reuse this exact same component
   * analysis instead of re-deriving boundary adjacency its own way.
   */
  edges: EdgeRecord[];
}

export interface BoundaryComponentLimits {
  maxComponents: number;
  maxSampleVerticesPerComponent: number;
}

export interface BoundaryAnalysis {
  totalBoundaryEdges: number;
  components: BoundaryComponent[];
  closedLoopCount: number;
  openChainCount: number;
  branchedCount: number;
  nonSimpleCount: number;
}

export function analyzeBoundaryComponents(edgesByKey: ReadonlyMap<string, EdgeRecord>, limits: BoundaryComponentLimits): BoundaryAnalysis {
  const boundaryEdges = [...edgesByKey.values()].filter((e) => e.edgeClass === "boundary");

  // Adjacency: vertex -> incident boundary edges (as [a,b] pairs), for both the component walk and per-vertex degree.
  const edgesByVertex = new Map<CanonicalVertexId, EdgeRecord[]>();
  for (const edge of boundaryEdges) {
    pushEdge(edgesByVertex, edge.a, edge);
    pushEdge(edgesByVertex, edge.b, edge);
  }

  const visitedEdgeKeys = new Set<string>();
  const components: BoundaryComponent[] = [];
  let closedLoopCount = 0;
  let openChainCount = 0;
  let branchedCount = 0;
  let nonSimpleCount = 0;

  for (const startEdge of boundaryEdges) {
    if (visitedEdgeKeys.has(startEdge.key)) continue;
    if (components.length >= limits.maxComponents) break; // reported honestly via totalBoundaryEdges even if this component list is truncated

    // Iterative BFS over boundary edges via shared vertices — never recursion.
    const componentEdges: EdgeRecord[] = [];
    const componentVertices = new Set<CanonicalVertexId>();
    const queue: CanonicalVertexId[] = [startEdge.a];
    const queuedVertices = new Set<CanonicalVertexId>(queue);

    while (queue.length > 0) {
      const v = queue.shift()!;
      componentVertices.add(v);
      for (const edge of edgesByVertex.get(v) ?? []) {
        if (!visitedEdgeKeys.has(edge.key)) {
          visitedEdgeKeys.add(edge.key);
          componentEdges.push(edge);
        }
        const other = edge.a === v ? edge.b : edge.a;
        if (!queuedVertices.has(other)) {
          queuedVertices.add(other);
          queue.push(other);
        }
      }
    }

    const degree = new Map<CanonicalVertexId, number>();
    for (const edge of componentEdges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }

    const kind = classifyComponent(componentEdges.length, componentVertices.size, degree);
    if (kind === "closed-loop") closedLoopCount++;
    else if (kind === "open-chain") openChainCount++;
    else if (kind === "branched") branchedCount++;
    else nonSimpleCount++;

    components.push({
      id: components.length,
      kind,
      edgeCount: componentEdges.length,
      vertexCount: componentVertices.size,
      sampleVertexIds: [...componentVertices].slice(0, limits.maxSampleVerticesPerComponent),
      edges: componentEdges,
    });
  }

  return { totalBoundaryEdges: boundaryEdges.length, components, closedLoopCount, openChainCount, branchedCount, nonSimpleCount };
}

function pushEdge(map: Map<CanonicalVertexId, EdgeRecord[]>, vertex: CanonicalVertexId, edge: EdgeRecord): void {
  let list = map.get(vertex);
  if (!list) {
    list = [];
    map.set(vertex, list);
  }
  list.push(edge);
}

function classifyComponent(edgeCount: number, vertexCount: number, degree: ReadonlyMap<CanonicalVertexId, number>): BoundaryComponentKind {
  let maxDegree = 0;
  let degreeOneCount = 0;
  for (const d of degree.values()) {
    if (d > maxDegree) maxDegree = d;
    if (d === 1) degreeOneCount++;
  }

  if (maxDegree >= 3) return "branched";
  if (maxDegree === 2 && degreeOneCount === 0 && edgeCount === vertexCount) return "closed-loop";
  if (degreeOneCount === 2 && edgeCount === vertexCount - 1) return "open-chain";
  return "non-simple";
}
