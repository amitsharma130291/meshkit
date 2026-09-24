import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { interpretFBXDocument } from "./document";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";
import { buildFBXBinary, connectionsSection, expectFBXError, objectNode, objectsSection, ooConnection, type FixtureNode } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

function interpret(nodes: FixtureNode[], limits: FBXLimits = LIMITS) {
  const buf = buildFBXBinary({ nodes });
  const parsed = parseFBXBinary(buf, limits);
  return interpretFBXDocument(parsed.version, parsed.uses64BitRecords, parsed.nodes, limits);
}

describe("interpretFBXDocument — objects and connections", () => {
  it("extracts id/class/subclass/name from an Objects section", () => {
    const doc = interpret([objectsSection([objectNode("Model", 1n, "Cube", "Mesh")])]);
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]).toMatchObject({ id: 1n, fbxClass: "Model", subclass: "Mesh", name: "Cube" });
  });

  it("extracts OO and OP connections", () => {
    const doc = interpret([
      connectionsSection([ooConnection(2n, 1n), { name: "C", properties: [{ type: "S", value: "OP" }, { type: "L", value: 3n }, { type: "L", value: 1n }, { type: "S", value: "DiffuseColor" }] }]),
    ]);
    expect(doc.connections).toHaveLength(2);
    expect(doc.connections[0]).toEqual({ kind: "OO", childId: 2n, parentId: 1n });
    expect(doc.connections[1]).toEqual({ kind: "OP", childId: 3n, parentId: 1n, propertyName: "DiffuseColor" });
  });

  it("rejects duplicate object IDs", () => {
    expectFBXError(
      () => interpret([objectsSection([objectNode("Model", 1n, "A", ""), objectNode("Model", 1n, "B", "")])]),
      "FBX_OBJECT_ID_DUPLICATE",
    );
  });

  it("enforces the object-count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxObjectCount: 2 };
    const objects = [objectNode("Model", 1n, "A", ""), objectNode("Model", 2n, "B", ""), objectNode("Model", 3n, "C", "")];
    expectFBXError(() => interpret([objectsSection(objects)], limits), "FBX_OBJECT_COUNT_EXCEEDED");
  });

  it("enforces the connection-count ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxConnectionCount: 1 };
    expectFBXError(() => interpret([connectionsSection([ooConnection(1n, 0n), ooConnection(2n, 0n)])], limits), "FBX_CONNECTION_COUNT_EXCEEDED");
  });

  it("silently skips a malformed individual connection tuple rather than failing the whole file", () => {
    const doc = interpret([connectionsSection([{ name: "C", properties: [{ type: "S", value: "OO" }] }, ooConnection(1n, 0n)])]);
    expect(doc.connections).toHaveLength(1);
  });

  it("records unrecognized top-level sections without failing", () => {
    const doc = interpret([{ name: "Takes" }, { name: "Pose" }]);
    expect(doc.unrecognizedTopLevelSections.sort()).toEqual(["Pose", "Takes"]);
  });

  it("extracts the Creator string from FBXHeaderExtension when present", () => {
    const doc = interpret([{ name: "FBXHeaderExtension", children: [{ name: "Creator", properties: [{ type: "S", value: "Blender (via MeshWrench test)" }] }] }]);
    expect(doc.creator).toBe("Blender (via MeshWrench test)");
  });

  it("returns null creator when FBXHeaderExtension is absent", () => {
    const doc = interpret([]);
    expect(doc.creator).toBeNull();
  });
});
