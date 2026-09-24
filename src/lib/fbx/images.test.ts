import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { extractVideoContent } from "./images";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";
import { buildFBXBinary, expectFBXError, videoNode } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function decode(content: Uint8Array | null, limits: FBXLimits = LIMITS) {
  const buf = buildFBXBinary({ nodes: [videoNode(1n, "tex.png", content)] });
  const doc = parseFBXBinary(buf, limits);
  return extractVideoContent(doc.nodes[0], limits);
}

describe("extractVideoContent", () => {
  it("extracts and identifies an embedded PNG", () => {
    const result = decode(PNG_MAGIC);
    expect(result.isExternalOnly).toBe(false);
    expect(result.isUnsupportedFormat).toBe(false);
    expect(result.image!.mimeType).toBe("image/png");
    expect(Array.from(result.image!.bytes)).toEqual(Array.from(PNG_MAGIC));
  });

  it("extracts and identifies an embedded JPEG", () => {
    const result = decode(JPEG_MAGIC);
    expect(result.image!.mimeType).toBe("image/jpeg");
  });

  it("treats a Video with no Content property as external-only, never fetched", () => {
    const result = decode(null);
    expect(result.isExternalOnly).toBe(true);
    expect(result.image).toBeNull();
  });

  it("treats zero embedded bytes as external-only", () => {
    const result = decode(new Uint8Array(0));
    expect(result.isExternalOnly).toBe(true);
  });

  it("flags an unrecognized embedded format without failing", () => {
    const result = decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result.isUnsupportedFormat).toBe(true);
    expect(result.image).toBeNull();
  });

  it("rejects an embedded image exceeding the size ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxImageBytes: 4 };
    expectFBXError(() => decode(PNG_MAGIC, limits), "FBX_IMAGE_TOO_LARGE");
  });
});
