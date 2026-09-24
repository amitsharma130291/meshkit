import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { interpretFBXDocument } from "./document";
import { buildConnectionGraph, connectedObjectsOfClass, resolveModelHierarchy } from "./connections";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";
import { buildFBXBinary, connectionsSection, expectFBXError, objectNode, objectsSection, ooConnection, type FixtureNode } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

function graphFrom(nodes: FixtureNode[], limits: FBXLimits = LIMITS) {
  const buf = buildFBXBinary({ nodes });
  const parsed = parseFBXBinary(buf, limits);
  const doc = interpretFBXDocument(parsed.version, parsed.uses64BitRecords, parsed.nodes, limits);
  return { doc, graph: buildConnectionGraph(doc) };
}

describe("buildConnectionGraph", () => {
  it("resolves connections independent of Objects/Connections declaration order", () => {
    // Connections declared BEFORE Objects — the graph must still resolve correctly.
    const { graph } = graphFrom([
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 1n)]),
      objectsSection([objectNode("Model", 1n, "Parent", "Null"), objectNode("Model", 2n, "Child", "Null")]),
    ]);
    expect(graph.childrenOf.get(1n)).toEqual([2n]);
    expect(graph.parentsOf.get(2n)).toEqual([1n]);
  });

  it("skips a dangling connection (reference to an object that doesn't exist) without failing", () => {
    const { graph } = graphFrom([objectsSection([objectNode("Model", 1n, "A", "Null")]), connectionsSection([ooConnection(999n, 1n)])]);
    expect(graph.danglingConnectionCount).toBe(1);
    expect(graph.childrenOf.get(1n) ?? []).toEqual([]);
  });

  it("detects multiple structural parents for the same object", () => {
    const { graph } = graphFrom([
      objectsSection([objectNode("Model", 1n, "A", "Null"), objectNode("Model", 2n, "B", "Null"), objectNode("Model", 3n, "Child", "Null")]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n), ooConnection(3n, 1n), ooConnection(3n, 2n)]),
    ]);
    expect(graph.multiParentObjectIds.has(3n)).toBe(true);
  });

  it("finds connected objects of a given class (e.g. Geometry attached to a Model)", () => {
    const { graph } = graphFrom([
      objectsSection([objectNode("Model", 1n, "Cube", "Mesh"), objectNode("Geometry", 2n, "CubeGeom", "Mesh"), objectNode("Material", 3n, "Mat", "")]),
      connectionsSection([ooConnection(2n, 1n), ooConnection(3n, 1n)]),
    ]);
    expect(connectedObjectsOfClass(graph, 1n, "Geometry").map((o) => o.id)).toEqual([2n]);
    expect(connectedObjectsOfClass(graph, 1n, "Material").map((o) => o.id)).toEqual([3n]);
  });
});

describe("resolveModelHierarchy", () => {
  it("builds a parent/child tree from Model OO connections, independent of declaration order", () => {
    const { graph } = graphFrom([
      objectsSection([
        objectNode("Model", 1n, "Root", "Null"),
        objectNode("Model", 2n, "Child", "Null"),
        objectNode("Model", 3n, "Grandchild", "Mesh"),
      ]),
      connectionsSection([ooConnection(3n, 2n), ooConnection(1n, 0n), ooConnection(2n, 1n)]),
    ]);
    const roots = resolveModelHierarchy(graph, LIMITS);
    expect(roots).toHaveLength(1);
    expect(roots[0].object.name).toBe("Root");
    expect(roots[0].children[0].object.name).toBe("Child");
    expect(roots[0].children[0].children[0].object.name).toBe("Grandchild");
  });

  it("treats a Model with no resolvable structural parent as a root", () => {
    const { graph } = graphFrom([objectsSection([objectNode("Model", 1n, "Orphan", "Null")])]);
    const roots = resolveModelHierarchy(graph, LIMITS);
    expect(roots.map((r) => r.object.name)).toEqual(["Orphan"]);
  });

  it("rejects a hierarchy cycle", () => {
    const { graph } = graphFrom([
      objectsSection([objectNode("Model", 1n, "A", "Null"), objectNode("Model", 2n, "B", "Null")]),
      connectionsSection([ooConnection(1n, 2n), ooConnection(2n, 1n)]),
    ]);
    expectFBXError(() => resolveModelHierarchy(graph, LIMITS), "FBX_HIERARCHY_CYCLE");
  });

  it("rejects excessive hierarchy depth", () => {
    const limits: FBXLimits = { ...LIMITS, maxHierarchyDepth: 3 };
    const objects = [];
    const conns = [];
    for (let i = 1; i <= 10; i++) {
      objects.push(objectNode("Model", BigInt(i), `N${i}`, "Null"));
      conns.push(ooConnection(BigInt(i), BigInt(i - 1)));
    }
    const { graph } = graphFrom([objectsSection(objects), connectionsSection(conns)], limits);
    expectFBXError(() => resolveModelHierarchy(graph, limits), "FBX_HIERARCHY_DEPTH_EXCEEDED");
  });

  it("supports multiple independent root models", () => {
    const { graph } = graphFrom([
      objectsSection([objectNode("Model", 1n, "A", "Null"), objectNode("Model", 2n, "B", "Null")]),
      connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n)]),
    ]);
    const roots = resolveModelHierarchy(graph, LIMITS);
    expect(roots.map((r) => r.object.name).sort()).toEqual(["A", "B"]);
  });
});
