import { describe, expect, it } from "vitest";
import { findPrimaryModelPath } from "./relationships";
import { openThreeMFPackage } from "./package";
import { DEFAULT_THREEMF_LIMITS } from "./types";
import { build3MFPackage, buildRelsXML, expectThreeMFError, simpleTriangleMesh, buildModelXML } from "./test-fixtures";

function openFixture(buffer: ArrayBuffer) {
  return openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS);
}

const modelXML = buildModelXML({
  objects: [simpleTriangleMesh("1")],
  buildItems: [{ objectId: "1" }],
});

describe("findPrimaryModelPath", () => {
  it("finds the model via a standard primary-model relationship", () => {
    const pkg = openFixture(build3MFPackage(modelXML, { modelPath: "3D/3dmodel.model" }));
    expect(findPrimaryModelPath(pkg)).toBe("3D/3dmodel.model");
  });

  it("finds the model when the relationship XML uses a namespace prefix", () => {
    const rels = buildRelsXML("3D/3dmodel.model", { namespacePrefix: "r" });
    const pkg = openFixture(build3MFPackage(modelXML, { relsXML: rels }));
    expect(findPrimaryModelPath(pkg)).toBe("3D/3dmodel.model");
  });

  it("normalizes a relative relationship target", () => {
    // A target without a leading slash is still relative to the package root.
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="3D/3dmodel.model"/></Relationships>`;
    const pkg = openFixture(build3MFPackage(modelXML, { relsXML: rels }));
    expect(findPrimaryModelPath(pkg)).toBe("3D/3dmodel.model");
  });

  it("rejects a relationship target that escapes the package root", () => {
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="../../etc/passwd"/></Relationships>`;
    const pkg = openFixture(build3MFPackage(modelXML, { relsXML: rels }));
    expectThreeMFError(() => findPrimaryModelPath(pkg), "THREEMF_RELATIONSHIP_INVALID");
  });

  it("rejects a relationship marked TargetMode=External", () => {
    const rels = buildRelsXML("3D/3dmodel.model", { external: true });
    const pkg = openFixture(build3MFPackage(modelXML, { relsXML: rels }));
    expectThreeMFError(() => findPrimaryModelPath(pkg), "THREEMF_RELATIONSHIP_INVALID");
  });

  it("rejects duplicate, ambiguous primary-model relationships", () => {
    const rels =
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>` +
      `<Relationship Id="r2" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/other.model"/>` +
      `</Relationships>`;
    const pkg = openFixture(
      build3MFPackage(modelXML, { relsXML: rels, extraFiles: { "3D/other.model": modelXML } }),
    );
    expectThreeMFError(() => findPrimaryModelPath(pkg), "THREEMF_RELATIONSHIP_INVALID");
  });

  it("falls back to the conventional path when _rels/.rels is absent", () => {
    const pkg = openFixture(build3MFPackage(modelXML, { modelPath: "3D/3dmodel.model", skipRels: true }));
    expect(findPrimaryModelPath(pkg)).toBe("3D/3dmodel.model");
  });

  it("fails clearly when there is no relationship and no conventional-path model either", () => {
    const pkg = openFixture(build3MFPackage(modelXML, { modelPath: "3D/custom.model", skipRels: true }));
    expectThreeMFError(() => findPrimaryModelPath(pkg), "THREEMF_MODEL_PART_MISSING");
  });
});
