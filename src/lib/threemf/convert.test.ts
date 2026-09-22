import { describe, expect, it } from "vitest";
import { convertThreeMFPackage } from "./convert";
import { serializeBinarySTL } from "../stl/serialize-binary";
import { parseBinarySTL } from "../stl/parse-binary";
import { build3MFPackage, buildModelXML, simpleTriangleMesh, expectThreeMFError } from "./test-fixtures";
import { DEFAULT_THREEMF_LIMITS } from "./types";

const limits = DEFAULT_THREEMF_LIMITS;

describe("convertThreeMFPackage — end to end", () => {
  it("converts a simple single-mesh package", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const result = convertThreeMFPackage(build3MFPackage(xml), limits);
    expect(result.triangleCount).toBe(1);
    expect(result.sourceUnit).toBe("millimeter");
  });

  it("converts a multi-object, component-based package with correct placement", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 50 0 0" }] },
      ],
      buildItems: [{ objectId: "2" }],
    });
    const result = convertThreeMFPackage(build3MFPackage(xml), limits);
    expect(result.triangleCount).toBe(1);
    expect(result.bounds.min[0]).toBeCloseTo(50, 5);
  });

  it("scales a non-millimeter source unit correctly", () => {
    const xml = buildModelXML({ unit: "centimeter", objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const result = convertThreeMFPackage(build3MFPackage(xml), limits);
    expect(result.sourceUnit).toBe("centimeter");
    // simpleTriangleMesh spans x:[0,10] in source units -> *10 for cm->mm = [0,100]
    expect(result.bounds.max[0]).toBeCloseTo(100, 5);
  });

  it("locates the model via the conventional-path fallback when _rels/.rels is absent", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const buffer = build3MFPackage(xml, { modelPath: "3D/3dmodel.model", skipRels: true });
    const result = convertThreeMFPackage(buffer, limits);
    expect(result.triangleCount).toBe(1);
  });

  it("produces a result whose serialized STL round-trips with matching bounds", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), simpleTriangleMesh("2")],
      buildItems: [{ objectId: "1" }, { objectId: "2", transform: "1 0 0 0 1 0 0 0 1 100 0 0" }],
    });
    const converted = convertThreeMFPackage(build3MFPackage(xml), limits);
    const stlBuffer = serializeBinarySTL({ positions: converted.positions, normals: converted.normals });
    const parsed = parseBinarySTL(stlBuffer, { maxTriangles: 1000 });

    expect(parsed.triangleCount).toBe(converted.triangleCount);
    expect(Array.from(parsed.positions)).toEqual(Array.from(converted.positions));
  });

  it("fails safely on an invalid package without leaking internal detail", () => {
    const garbage = new TextEncoder().encode("not a zip").buffer as ArrayBuffer;
    expectThreeMFError(() => convertThreeMFPackage(garbage, limits), "THREEMF_INVALID_PACKAGE");
  });
});
