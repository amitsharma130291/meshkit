/**
 * Connected shell (triangle-component) resolution. Two triangles belong
 * to the same shell only when they share a topology EDGE — i.e. an edge
 * with two or more incident triangles (manifold or non-manifold; a
 * boundary edge, by definition, has only one incident triangle and so
 * never merges anything). A point-only contact (two triangles that share
 * a vertex but no edge) never appears in the edge map at all, so it can
 * never merge two shells either — the "point-touching shells stay
 * separate" policy falls directly out of this definition rather than
 * needing special-case code.
 *
 * Implemented as iterative union-find (path compression + union by rank)
 * over triangle indices, never JS recursion — a pathological or
 * adversarial mesh with a very long triangle chain must fail via this
 * module's own edge-record ceiling (`edge-incidence.ts`), not a native
 * call-stack overflow.
 */
import type { CanonicalTriangle, EdgeRecord } from "./topology-types";

/**
 * Exported (not just used internally) so `src/lib/stl-repair/weld.ts` can
 * reuse the exact same iterative, path-compressed union-find for
 * clustering nearby vertices during welding — a generic, well-tested
 * primitive, not a topology definition, so sharing it isn't the kind of
 * duplication Phase 6 was told to avoid; re-implementing it a second time
 * would be.
 */
export class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
    this.rank = new Uint8Array(size);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    // Iterative path compression — a second pass, not recursion.
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

export interface TriangleShells {
  /** `triangleIndex -> shellId` (0-based, dense). Only covers valid (non-degenerate) triangles. */
  shellIdByTriangleIndex: Map<number, number>;
  /** `shellId -> triangle indices`, in ascending order. */
  triangleIndicesByShell: number[][];
  shellCount: number;
}

export function resolveTriangleShells(triangles: readonly CanonicalTriangle[], edgesByKey: ReadonlyMap<string, EdgeRecord>): TriangleShells {
  // A local, dense 0..n-1 index space over just the valid triangles passed
  // in — `CanonicalTriangle.index` is the original file-order index, which
  // may have gaps once degenerate triangles are excluded.
  const denseIndexByTriangleIndex = new Map<number, number>();
  triangles.forEach((tri, i) => denseIndexByTriangleIndex.set(tri.index, i));

  const uf = new UnionFind(triangles.length);
  for (const edge of edgesByKey.values()) {
    if (edge.uses.length < 2) continue; // boundary edge — never merges shells
    const first = denseIndexByTriangleIndex.get(edge.uses[0].triangleIndex)!;
    for (let i = 1; i < edge.uses.length; i++) {
      uf.union(first, denseIndexByTriangleIndex.get(edge.uses[i].triangleIndex)!);
    }
  }

  const shellIdByRoot = new Map<number, number>();
  const triangleIndicesByShell: number[][] = [];
  const shellIdByTriangleIndex = new Map<number, number>();

  triangles.forEach((tri, denseIndex) => {
    const root = uf.find(denseIndex);
    let shellId = shellIdByRoot.get(root);
    if (shellId === undefined) {
      shellId = triangleIndicesByShell.length;
      shellIdByRoot.set(root, shellId);
      triangleIndicesByShell.push([]);
    }
    triangleIndicesByShell[shellId].push(tri.index);
    shellIdByTriangleIndex.set(tri.index, shellId);
  });

  return { shellIdByTriangleIndex, triangleIndicesByShell, shellCount: triangleIndicesByShell.length };
}
