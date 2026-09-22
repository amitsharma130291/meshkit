import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openThreeMFPackage } from "./package";
import { DEFAULT_THREEMF_LIMITS, type ThreeMFLimits } from "./types";
import { build3MFPackage, buildModelXML, expectThreeMFError, markEntryEncrypted, simpleTriangleMesh } from "./test-fixtures";

const modelXML = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });

describe("openThreeMFPackage", () => {
  it("opens a valid package and lists its entries", () => {
    const pkg = openThreeMFPackage(build3MFPackage(modelXML), DEFAULT_THREEMF_LIMITS);
    expect(pkg.entryNames.has("3D/3dmodel.model")).toBe(true);
    expect(pkg.entryNames.has("_rels/.rels")).toBe(true);
  });

  it("reads an entry's decompressed content correctly", () => {
    const pkg = openThreeMFPackage(build3MFPackage(modelXML), DEFAULT_THREEMF_LIMITS);
    const bytes = pkg.readEntry("3D/3dmodel.model");
    expect(new TextDecoder().decode(bytes)).toBe(modelXML);
  });

  it("rejects an empty buffer", () => {
    expectThreeMFError(() => openThreeMFPackage(new ArrayBuffer(0), DEFAULT_THREEMF_LIMITS), "THREEMF_INVALID_PACKAGE");
  });

  it("rejects a buffer that isn't a ZIP at all", () => {
    const garbage = new TextEncoder().encode("this is not a zip file, just plain text padding").buffer;
    expectThreeMFError(() => openThreeMFPackage(garbage as ArrayBuffer, DEFAULT_THREEMF_LIMITS), "THREEMF_INVALID_PACKAGE");
  });

  it("rejects a corrupted central directory record signature", () => {
    const buffer = build3MFPackage(modelXML);
    const bytes = new Uint8Array(buffer.slice(0));
    // Central directory records start with PK\x01\x02 (0x50,0x4b,0x01,0x02) — corrupt the first one found.
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
        bytes[i] = 0x00;
        break;
      }
    }
    expectThreeMFError(() => openThreeMFPackage(bytes.buffer as ArrayBuffer, DEFAULT_THREEMF_LIMITS), "THREEMF_ZIP_CORRUPT");
  });

  it("rejects a package with an encrypted entry", () => {
    const buffer = markEntryEncrypted(build3MFPackage(modelXML), "3D/3dmodel.model");
    expectThreeMFError(() => openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS), "THREEMF_ZIP_ENCRYPTED");
  });

  it("rejects a package over the compressed-size ceiling", () => {
    const buffer = build3MFPackage(modelXML);
    const limits: ThreeMFLimits = { ...DEFAULT_THREEMF_LIMITS, maxCompressedPackageBytes: buffer.byteLength - 1 };
    expectThreeMFError(() => openThreeMFPackage(buffer, limits), "THREEMF_PACKAGE_TOO_LARGE");
  });

  it("rejects a package with too many ZIP entries", () => {
    const files: Record<string, Uint8Array> = {
      "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>`),
      "3D/3dmodel.model": strToU8(modelXML),
    };
    for (let i = 0; i < 10; i++) {
      files[`extra/file-${i}.txt`] = strToU8("padding");
    }
    const buffer = zipSync(files).buffer as ArrayBuffer;
    const limits: ThreeMFLimits = { ...DEFAULT_THREEMF_LIMITS, maxZipEntries: 5 };
    expectThreeMFError(() => openThreeMFPackage(buffer, limits), "THREEMF_ZIP_BOMB_SUSPECTED");
  });

  it("rejects an entry whose declared size exceeds the single-entry ceiling", () => {
    const buffer = build3MFPackage(modelXML);
    const limits: ThreeMFLimits = { ...DEFAULT_THREEMF_LIMITS, maxSingleEntryDecompressedBytes: 10 };
    expectThreeMFError(() => openThreeMFPackage(buffer, limits), "THREEMF_ZIP_BOMB_SUSPECTED");
  });

  it("rejects a suspicious compression ratio", () => {
    // A large, highly-repetitive (and therefore highly compressible) model.xml.
    const paddedModelXML = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      unsupportedFeatures: [],
    }) + "<!-- " + "x".repeat(200_000) + " -->";
    const buffer = build3MFPackage(paddedModelXML);
    const limits: ThreeMFLimits = { ...DEFAULT_THREEMF_LIMITS, maxCompressionRatio: 5 };
    expectThreeMFError(() => openThreeMFPackage(buffer, limits), "THREEMF_ZIP_BOMB_SUSPECTED");
  });

  it("rejects path traversal in an entry name", () => {
    const buffer = build3MFPackage(modelXML, { extraFiles: { "../evil.txt": "gotcha" } });
    expectThreeMFError(() => openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS), "THREEMF_INVALID_PACKAGE");
  });

  it("rejects an absolute path entry name", () => {
    const buffer = build3MFPackage(modelXML, { extraFiles: { "/etc/passwd": "gotcha" } });
    expectThreeMFError(() => openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS), "THREEMF_INVALID_PACKAGE");
  });

  it("throws MODEL_PART_MISSING when reading a name that isn't in the archive", () => {
    const pkg = openThreeMFPackage(build3MFPackage(modelXML), DEFAULT_THREEMF_LIMITS);
    expectThreeMFError(() => pkg.readEntry("does/not/exist"), "THREEMF_MODEL_PART_MISSING");
  });
});
