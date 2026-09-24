/**
 * The mutable, in-worker representation edge collapses actually operate
 * on. Built once from Phase 5's own immutable `CanonicalMesh` +
 * `EdgeIncidence` + `TriangleShells` — never a second topology model, and
 * never mutates any of those source structures. Every vertex/triangle id
 * here is exactly the canonical mesh's own dense 0-based index, so
 * "deterministic ids" falls out of reusing Phase 5's own ids rather than
 * inventing a new numbering.
 */
import type { CanonicalMesh } from "../mesh/canonical-vertices";
import type { EdgeIncidence } from "../mesh/edge-incidence";
import type { TriangleShells } from "../mesh/connected-components";

export interface IndexedMesh {
  /** Mutable copy of the canonical mesh's unique vertex positions — flat [x,y,z, ...]. The source `CanonicalMesh.vertices` is never touched. */
  positions: Float32Array;
  vertexCount: number;
  vertexActive: Uint8Array;
  /** 1 if this vertex touches at least one boundary edge in the ORIGINAL topology — boundary status is fixed at build time, never recomputed mid-simplification (collapses that would change it are rejected by collapse-validation.ts instead). */
  vertexIsBoundary: Uint8Array;
  vertexShellId: Int32Array;
  /** Flat [v0,v1,v2, v0,v1,v2, ...], length `triangleCount * 3`. */
  triangleVertexIds: Int32Array;
  triangleCount: number;
  triangleActive: Uint8Array;
  /** vertexId -> live Set of currently-active incident triangle indices. Maintained incrementally by `collapseEdge`, never rebuilt from scratch. */
  incidentTriangles: Map<number, Set<number>>;
  shellCount: number;
  /** Bumped by exactly 1 on every `collapseEdge` call — the signal `edge-candidates.ts` uses for lazy invalidation. */
  version: number;
}

export function buildIndexedMesh(canonical: CanonicalMesh, edges: EdgeIncidence, shells: TriangleShells): IndexedMesh {
  const vertexCount = canonical.uniqueVertexCount;
  const triangleCount = canonical.validTriangles.length;

  const positions = canonical.vertices.slice(); // own mutable copy
  const vertexActive = new Uint8Array(vertexCount).fill(1);
  const vertexIsBoundary = new Uint8Array(vertexCount);
  const vertexShellId = new Int32Array(vertexCount).fill(-1);
  const triangleVertexIds = new Int32Array(triangleCount * 3);
  const triangleActive = new Uint8Array(triangleCount).fill(1);
  const incidentTriangles = new Map<number, Set<number>>();
  for (let v = 0; v < vertexCount; v++) incidentTriangles.set(v, new Set());

  // Dense local index (0..triangleCount-1) parallel to `canonical.validTriangles`,
  // matching the same local numbering `resolveTriangleShells` itself used.
  canonical.validTriangles.forEach((triangle, localIndex) => {
    const [a, b, c] = triangle.vertexIds;
    triangleVertexIds[localIndex * 3] = a;
    triangleVertexIds[localIndex * 3 + 1] = b;
    triangleVertexIds[localIndex * 3 + 2] = c;
    incidentTriangles.get(a)!.add(localIndex);
    incidentTriangles.get(b)!.add(localIndex);
    incidentTriangles.get(c)!.add(localIndex);

    const shellId = shells.shellIdByTriangleIndex.get(triangle.index) ?? -1;
    vertexShellId[a] = shellId;
    vertexShellId[b] = shellId;
    vertexShellId[c] = shellId;
  });

  for (const edge of edges.edgesByKey.values()) {
    if (edge.edgeClass === "boundary") {
      vertexIsBoundary[edge.a] = 1;
      vertexIsBoundary[edge.b] = 1;
    }
  }

  return {
    positions,
    vertexCount,
    vertexActive,
    vertexIsBoundary,
    vertexShellId,
    triangleVertexIds,
    triangleCount,
    triangleActive,
    incidentTriangles,
    shellCount: shells.shellCount,
    version: 0,
  };
}

export function activeVertexCount(mesh: IndexedMesh): number {
  let count = 0;
  for (let v = 0; v < mesh.vertexCount; v++) if (mesh.vertexActive[v] === 1) count++;
  return count;
}

export function activeTriangleCount(mesh: IndexedMesh): number {
  let count = 0;
  for (let t = 0; t < mesh.triangleCount; t++) if (mesh.triangleActive[t] === 1) count++;
  return count;
}

export function getVertexPosition(mesh: IndexedMesh, vertexId: number): [number, number, number] {
  return [mesh.positions[vertexId * 3], mesh.positions[vertexId * 3 + 1], mesh.positions[vertexId * 3 + 2]];
}

export function getTriangleVertexIds(mesh: IndexedMesh, triangleIndex: number): [number, number, number] {
  return [
    mesh.triangleVertexIds[triangleIndex * 3],
    mesh.triangleVertexIds[triangleIndex * 3 + 1],
    mesh.triangleVertexIds[triangleIndex * 3 + 2],
  ];
}

export function getIncidentTriangles(mesh: IndexedMesh, vertexId: number): ReadonlySet<number> {
  return mesh.incidentTriangles.get(vertexId) ?? new Set();
}

export interface CollapseResult {
  removedTriangleIndices: number[];
  /** Triangles that survived but had `from` renumbered to `to` — these need their quadric/candidate data refreshed. */
  updatedTriangleIndices: number[];
}

/**
 * Applies one edge collapse: `from` is merged into `to` at `newPosition`.
 * Every triangle incident to `from` is renumbered; a renumbered triangle
 * that now repeats a vertex (i.e. `from` and `to` were both in the same
 * triangle) is deactivated rather than left degenerate. Callers
 * (`collapse-validation.ts`) are responsible for verifying the collapse
 * is SAFE before calling this — this function performs the mutation
 * unconditionally and never itself decides safety.
 */
export function collapseEdge(mesh: IndexedMesh, from: number, to: number, newPosition: readonly [number, number, number]): CollapseResult {
  const removedTriangleIndices: number[] = [];
  const updatedTriangleIndices: number[] = [];

  mesh.positions[to * 3] = newPosition[0];
  mesh.positions[to * 3 + 1] = newPosition[1];
  mesh.positions[to * 3 + 2] = newPosition[2];

  const fromTriangles = new Set(getIncidentTriangles(mesh, from));
  const toIncidence = mesh.incidentTriangles.get(to)!;

  for (const t of fromTriangles) {
    if (mesh.triangleActive[t] === 0) continue;
    const base = t * 3;
    const verts: [number, number, number] = [mesh.triangleVertexIds[base], mesh.triangleVertexIds[base + 1], mesh.triangleVertexIds[base + 2]];
    const renumbered = verts.map((v) => (v === from ? to : v)) as [number, number, number];

    // Degenerate after renumbering: `from` and `to` were both corners of this triangle.
    if (renumbered[0] === renumbered[1] || renumbered[1] === renumbered[2] || renumbered[0] === renumbered[2]) {
      mesh.triangleActive[t] = 0;
      removedTriangleIndices.push(t);
      for (const v of verts) mesh.incidentTriangles.get(v)?.delete(t);
      continue;
    }

    mesh.triangleVertexIds[base] = renumbered[0];
    mesh.triangleVertexIds[base + 1] = renumbered[1];
    mesh.triangleVertexIds[base + 2] = renumbered[2];
    mesh.incidentTriangles.get(from)!.delete(t);
    toIncidence.add(t);
    updatedTriangleIndices.push(t);
  }

  mesh.vertexActive[from] = 0;
  mesh.incidentTriangles.set(from, new Set());
  mesh.version += 1;

  return { removedTriangleIndices, updatedTriangleIndices };
}
