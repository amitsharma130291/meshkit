import { describe, expect, it } from "vitest";
import { buildCanonicalMesh } from "../mesh/canonical-vertices";
import { buildEdgeIncidence } from "../mesh/edge-incidence";
import { resolveTriangleShells } from "../mesh/connected-components";
import { analyzeBoundaryComponents } from "../mesh/boundary-components";
import { edgeKeyString } from "../mesh/topology-types";
import { buildIndexedMesh } from "./indexed-mesh";
import { boundaryEdgeKeysFromClosedLoops, DEFAULT_COLLAPSE_POLICY, validateCollapse } from "./collapse-validation";

const DEFAULT_LIMITS = { maxUniqueVertices: 100_000 };
const EDGE_LIMITS = { maxEdgeRecords: 100_000 };
const BOUNDARY_LIMITS = { maxComponents: 1000, maxSampleVerticesPerComponent: 1000 };

function tetrahedron(): Float32Array {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0.5, 1, 0];
  const d: [number, number, number] = [0.5, 0.4, 1];
  const out: number[] = [];
  const push = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => out.push(...p, ...q, ...r);
  push(a, b, c);
  push(a, c, d);
  push(a, d, b);
  push(b, d, c);
  return Float32Array.from(out);
}

/** A 2x2 grid of quads (9 vertices, 8 triangles) — has genuine interior edges with a well-formed vertex link. */
function grid2x2(): Float32Array {
  return grid(2);
}

/** An NxN grid of quads. N>=3 gives at least one interior-to-interior edge (grid2x2's single interior vertex has only boundary neighbors). */
function grid(n: number): Float32Array {
  const p = (x: number, y: number): [number, number, number] => [x, y, 0];
  const out: number[] = [];
  const push = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => out.push(...a, ...b, ...c);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const a = p(gx, gy);
      const b = p(gx + 1, gy);
      const c = p(gx + 1, gy + 1);
      const d = p(gx, gy + 1);
      push(a, b, c);
      push(a, c, d);
    }
  }
  return Float32Array.from(out);
}

/** Two separate closed tetrahedra (two shells), far apart. */
function twoTetrahedra(): Float32Array {
  const t1 = tetrahedron();
  const t2 = tetrahedron();
  for (let i = 0; i < t2.length; i += 3) t2[i] += 100; // translate shell 2 far away on x
  return Float32Array.from([...t1, ...t2]);
}

async function build(positions: Float32Array) {
  const canonical = await buildCanonicalMesh(positions, DEFAULT_LIMITS);
  const edges = buildEdgeIncidence(canonical.validTriangles, EDGE_LIMITS);
  const shells = resolveTriangleShells(canonical.validTriangles, edges.edgesByKey);
  const boundary = analyzeBoundaryComponents(edges.edgesByKey, BOUNDARY_LIMITS);
  const mesh = buildIndexedMesh(canonical, edges, shells);
  const boundaryEdgeKeys = boundaryEdgeKeysFromClosedLoops(boundary);
  return { canonical, edges, shells, boundary, mesh, boundaryEdgeKeys };
}

describe("validateCollapse — finite-input rejection", () => {
  it("rejects a non-finite proposed position", async () => {
    const { mesh, boundaryEdgeKeys } = await build(tetrahedron());
    const result = validateCollapse(mesh, 0, 1, [NaN, 0, 0], { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("non-finite-position");
  });
});

describe("validateCollapse — shell integrity", () => {
  it("rejects a collapse across two different shells", async () => {
    const { mesh, boundaryEdgeKeys, canonical } = await build(twoTetrahedra());
    // vertex 0 is in shell 0's tetrahedron; find a vertex in the second shell.
    const secondShellVertex = canonical.validTriangles.find((t) => mesh.vertexShellId[t.vertexIds[0]] !== mesh.vertexShellId[0])!.vertexIds[0];
    const result = validateCollapse(mesh, 0, secondShellVertex, [0, 0, 0], { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("different-shells");
  });

  it("rejects a collapse that would drop a shell below the configured minimum triangle count", async () => {
    // Any edge collapse on a minimal 4-face tetrahedron removes the 2
    // triangles sharing that edge AND leaves the remaining 2 triangles as
    // literal duplicates of each other (a real, unavoidable property of
    // collapsing a 4-face closed solid down to 2 faces, discovered by this
    // very test while writing it) — so this fixture legitimately triggers
    // two simultaneously-true rejection reasons. The safety contract this
    // test actually cares about is "unsafe collapses on a minimal shell are
    // always rejected," not which of the two true reasons is reported first.
    const { mesh, boundaryEdgeKeys } = await build(tetrahedron()); // 4 triangles, 1 shell
    const policy = { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys, minTrianglesPerShell: 4 };
    const result = validateCollapse(mesh, 0, 1, [0.5, 0, 0], policy);
    expect(result.safe).toBe(false);
    expect(["shell-would-drop-below-minimum", "would-create-duplicate-triangle"]).toContain(result.reason);
  });

  it("rejects a collapse that would drop a shell below the configured minimum, isolated from any duplicate-triangle side effect", async () => {
    // A 3x3 grid (18 triangles) has plenty of margin to collapse one
    // boundary edge without creating a duplicate, so a strict
    // minTrianglesPerShell can be isolated as the ONLY true rejection
    // reason here.
    const { mesh, boundaryEdgeKeys } = await build(grid(3));
    const [key] = boundaryEdgeKeys;
    const [a, b] = key.split("_").map(Number);
    const midpoint: [number, number, number] = [
      (mesh.positions[a * 3] + mesh.positions[b * 3]) / 2,
      (mesh.positions[a * 3 + 1] + mesh.positions[b * 3 + 1]) / 2,
      (mesh.positions[a * 3 + 2] + mesh.positions[b * 3 + 2]) / 2,
    ];
    const policy = { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys, minTrianglesPerShell: 18 };
    const result = validateCollapse(mesh, a, b, midpoint, policy);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("shell-would-drop-below-minimum");
  });
});

describe("validateCollapse — boundary policy", () => {
  it("rejects a collapse mixing a boundary vertex with an interior vertex", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid2x2());
    const boundaryVertex = mesh.vertexIsBoundary.findIndex((v) => v === 1);
    const interiorVertex = mesh.vertexIsBoundary.findIndex((v) => v === 0);
    expect(interiorVertex).toBeGreaterThanOrEqual(0); // sanity: the 2x2 grid's center vertex is interior
    const result = validateCollapse(mesh, boundaryVertex, interiorVertex, [0, 0, 0], { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("boundary-interior-mixed");
  });

  it("rejects a boundary-to-boundary collapse across two vertices that are not adjacent on the same boundary loop", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid2x2());
    // Two boundary corners on the SAME loop but not edge-adjacent (a diagonal-ish pair).
    const boundaryVerts: number[] = [];
    for (let v = 0; v < mesh.vertexCount; v++) if (mesh.vertexIsBoundary[v] === 1) boundaryVerts.push(v);
    const nonAdjacentPair = boundaryVerts.find((a) => boundaryVerts.some((b) => b !== a && !boundaryEdgeKeys.has(edgeKeyString(a, b))));
    expect(nonAdjacentPair).toBeDefined();
    const other = boundaryVerts.find((b) => b !== nonAdjacentPair && !boundaryEdgeKeys.has(edgeKeyString(nonAdjacentPair!, b)))!;
    const result = validateCollapse(mesh, nonAdjacentPair!, other, [0, 0, 0], { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("boundary-non-adjacent");
  });

  it("allows a boundary-to-boundary collapse between two vertices adjacent on the same closed boundary loop", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid2x2());
    const [key] = boundaryEdgeKeys;
    const [a, b] = key.split("_").map(Number);
    const midpoint: [number, number, number] = [
      (mesh.positions[a * 3] + mesh.positions[b * 3]) / 2,
      (mesh.positions[a * 3 + 1] + mesh.positions[b * 3 + 1]) / 2,
      (mesh.positions[a * 3 + 2] + mesh.positions[b * 3 + 2]) / 2,
    ];
    const result = validateCollapse(mesh, a, b, midpoint, { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(true);
  });
});

/** Finds two interior (non-boundary) vertices that share at least one active triangle, i.e. a genuine interior-to-interior edge. */
function findInteriorAdjacentPair(mesh: Awaited<ReturnType<typeof build>>["mesh"]): [number, number] {
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (mesh.vertexIsBoundary[v] === 1) continue;
    for (const t of mesh.incidentTriangles.get(v)!) {
      const base = t * 3;
      const other = [mesh.triangleVertexIds[base], mesh.triangleVertexIds[base + 1], mesh.triangleVertexIds[base + 2]].find(
        (candidate) => candidate !== v && mesh.vertexIsBoundary[candidate] === 0,
      );
      if (other !== undefined) return [v, other];
    }
  }
  throw new Error("fixture has no interior-to-interior edge");
}

describe("validateCollapse — link condition (interior manifold safety)", () => {
  it("allows a safe interior-to-interior collapse at the shared edge's own midpoint on a well-formed grid", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid(3));
    const [interiorVertex, other] = findInteriorAdjacentPair(mesh);
    const midpoint: [number, number, number] = [
      (mesh.positions[interiorVertex * 3] + mesh.positions[other * 3]) / 2,
      (mesh.positions[interiorVertex * 3 + 1] + mesh.positions[other * 3 + 1]) / 2,
      (mesh.positions[interiorVertex * 3 + 2] + mesh.positions[other * 3 + 2]) / 2,
    ];
    const result = validateCollapse(mesh, interiorVertex, other, midpoint, { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(true);
  });

  it("rejects a collapse that would violate the link condition (would create a non-manifold vertex)", () => {
    // Direct white-box fixture (bypassing the triangle-soup pipeline,
    // since constructing a minimal link-condition counterexample that
    // ALSO satisfies this codebase's own edge-based shell definition and
    // stays interior-only in boundary classification is awkward to
    // express as raw STL-style triangle soup — this tests
    // `validateCollapse`'s own logic directly, a legitimate unit-test
    // scope). Edge (a=0,b=1) is a normal manifold edge shared by
    // triangles T0=(a,b,c) and T1=(a,b,d), so link(edge ab) = {c=2,d=3}.
    // Triangles T2=(a,e,x) and T3=(b,e,y) additionally make e=4 a
    // neighbor of BOTH a and b — but e is not in {c,d}. That extra
    // coincidental shared neighbor is exactly what the link condition
    // must catch: collapsing a-b here would pinch the surface into a
    // non-manifold vertex at e.
    const vertexCount = 7; // a,b,c,d,e,x,y
    const positions = new Float32Array(vertexCount * 3); // exact coordinates are irrelevant to this topology-only check
    const mesh = {
      positions,
      vertexCount,
      vertexActive: new Uint8Array(vertexCount).fill(1),
      vertexIsBoundary: new Uint8Array(vertexCount).fill(0), // interior-only, by construction
      vertexShellId: new Int32Array(vertexCount).fill(0), // one shell, by construction
      triangleVertexIds: Int32Array.from([
        0, 1, 2, // T0 = a,b,c
        0, 1, 3, // T1 = a,b,d
        0, 4, 5, // T2 = a,e,x
        1, 4, 6, // T3 = b,e,y
      ]),
      triangleCount: 4,
      triangleActive: new Uint8Array(4).fill(1),
      incidentTriangles: new Map<number, Set<number>>([
        [0, new Set([0, 1, 2])],
        [1, new Set([0, 1, 3])],
        [2, new Set([0])],
        [3, new Set([1])],
        [4, new Set([2, 3])],
        [5, new Set([2])],
        [6, new Set([3])],
      ]),
      shellCount: 1,
      version: 0,
    };
    const result = validateCollapse(mesh, 0, 1, [0, 0, 0], { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys: new Set(), minTrianglesPerShell: 1 });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("link-condition-failed");
  });
});

/** Finds two interior (non-boundary) vertices that share at least one active triangle, i.e. a genuine interior-to-interior edge. */
describe("validateCollapse — degenerate/duplicate prevention", () => {
  it("rejects a collapse whose new position would make a surviving triangle zero-area", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid(3));
    const [interiorVertex, neighbor] = findInteriorAdjacentPair(mesh);
    const triangle = [...mesh.incidentTriangles.get(interiorVertex)!].find((t) => mesh.incidentTriangles.get(neighbor)!.has(t))!;
    const base = triangle * 3;
    const thirdVertex = [mesh.triangleVertexIds[base], mesh.triangleVertexIds[base + 1], mesh.triangleVertexIds[base + 2]].find(
      (v) => v !== interiorVertex && v !== neighbor,
    )!;
    // Collapse onto the exact same position as a THIRD vertex of a surviving triangle -> zero area.
    const collapsedPosition: [number, number, number] = [mesh.positions[thirdVertex * 3], mesh.positions[thirdVertex * 3 + 1], mesh.positions[thirdVertex * 3 + 2]];
    const result = validateCollapse(mesh, interiorVertex, neighbor, collapsedPosition, { ...DEFAULT_COLLAPSE_POLICY, boundaryEdgeKeys });
    expect(result.safe).toBe(false);
    expect(["would-create-degenerate-triangle", "link-condition-failed"]).toContain(result.reason);
  });
});

describe("validateCollapse — normal-flip threshold", () => {
  it("rejects a collapse whose new position flips a surviving triangle's normal beyond the allowed angle", async () => {
    const { mesh, boundaryEdgeKeys } = await build(grid(3));
    const [interiorVertex, neighbor] = findInteriorAdjacentPair(mesh);
    // Move the collapsed vertex far below the plane — flips any surviving flat triangle's normal.
    const result = validateCollapse(mesh, interiorVertex, neighbor, [0.5, 0.5, -50], {
      ...DEFAULT_COLLAPSE_POLICY,
      boundaryEdgeKeys,
      maxNormalFlipAngleDeg: 10,
    });
    expect(result.safe).toBe(false);
  });
});
