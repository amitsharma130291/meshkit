import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { writeThreeMFPackage } from "./package-writer";
import { openThreeMFPackage } from "./package";
import { findPrimaryModelPath } from "./relationships";
import { DEFAULT_THREEMF_LIMITS } from "./types";

const LIMITS = { maxOutputBytes: 200 * 1024 * 1024 };

const SAMPLE_MODEL_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
  `<resources><object id="1" type="model"><mesh>` +
  `<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>` +
  `<triangles><triangle v1="0" v2="1" v3="2"/></triangles>` +
  `</mesh></object></resources><build><item objectid="1"/></build></model>`;

describe("writeThreeMFPackage — required entries", () => {
  it("contains exactly the three required entries at exact paths", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const unzipped = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(unzipped).sort()).toEqual(["3D/3dmodel.model", "_rels/.rels", "[Content_Types].xml"].sort());
  });

  it("declares the correct model content type", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const unzipped = unzipSync(new Uint8Array(buffer));
    const contentTypes = new TextDecoder().decode(unzipped["[Content_Types].xml"]);
    expect(contentTypes).toContain('Extension="model"');
    expect(contentTypes).toContain("application/vnd.ms-package.3dmanufacturing-3dmodel+xml");
  });

  it("declares the correct package-level relationship", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const unzipped = unzipSync(new Uint8Array(buffer));
    const rels = new TextDecoder().decode(unzipped["_rels/.rels"]);
    expect(rels).toContain("http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel");
    expect(rels).toContain('Target="/3D/3dmodel.model"');
  });

  it("writes the model XML unchanged", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const unzipped = unzipSync(new Uint8Array(buffer));
    expect(new TextDecoder().decode(unzipped["3D/3dmodel.model"])).toBe(SAMPLE_MODEL_XML);
  });

  it("adds no extra package entries", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const unzipped = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(unzipped)).toHaveLength(3);
  });
});

describe("writeThreeMFPackage — opens with the production 3MF reader", () => {
  it("parses with openThreeMFPackage and findPrimaryModelPath", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const pkg = openThreeMFPackage(buffer, DEFAULT_THREEMF_LIMITS);
    const modelPath = findPrimaryModelPath(pkg);
    expect(modelPath).toBe("3D/3dmodel.model");
    expect(new TextDecoder().decode(pkg.readEntry(modelPath))).toBe(SAMPLE_MODEL_XML);
  });
});

describe("writeThreeMFPackage — determinism and limits", () => {
  it("produces byte-identical output for identical input across repeated calls", () => {
    const a = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const b = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    expect(Array.from(new Uint8Array(a))).toEqual(Array.from(new Uint8Array(b)));
  });

  it("enforces the output-size ceiling", () => {
    expect(() => writeThreeMFPackage(SAMPLE_MODEL_XML, { maxOutputBytes: 10 })).toThrow();
    try {
      writeThreeMFPackage(SAMPLE_MODEL_XML, { maxOutputBytes: 10 });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("THREEMF_OUTPUT_TOO_LARGE");
    }
  });

  it("never produces an encrypted entry (general-purpose flag bit 0 unset)", () => {
    const buffer = writeThreeMFPackage(SAMPLE_MODEL_XML, LIMITS);
    const bytes = new Uint8Array(buffer);
    // Scan local file headers (signature 0x04034b50) and check the encryption flag bit.
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
        const flags = bytes[i + 6] | (bytes[i + 7] << 8);
        expect(flags & 0x0001).toBe(0);
      }
    }
  });
});
