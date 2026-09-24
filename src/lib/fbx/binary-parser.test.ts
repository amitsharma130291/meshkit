import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { DEFAULT_FBX_LIMITS, type FBXLimits } from "./types";
import { buildAsciiFBX, buildFBXBinary, expectFBXError, truncateBuffer } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

describe("parseFBXBinary — header validation", () => {
  it("parses a minimal valid binary FBX with one empty top-level node", () => {
    const buf = buildFBXBinary({ version: 7400, nodes: [{ name: "GlobalSettings" }] });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(doc.version).toBe(7400);
    expect(doc.uses64BitRecords).toBe(false);
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0].name).toBe("GlobalSettings");
  });

  it("rejects an invalid magic header", () => {
    const buf = buildFBXBinary({ nodes: [], magicOverride: new Uint8Array(23).fill(0x41) });
    expectFBXError(() => parseFBXBinary(buf, LIMITS), "FBX_MAGIC_INVALID");
  });

  it("rejects a file too short to contain the header", () => {
    const buf = new ArrayBuffer(10);
    expectFBXError(() => parseFBXBinary(buf, LIMITS), "FBX_HEADER_TRUNCATED");
  });

  it("clearly and distinctly rejects an ASCII FBX file", () => {
    const buf = buildAsciiFBX();
    expectFBXError(() => parseFBXBinary(buf, LIMITS), "FBX_ASCII_DETECTED");
  });

  it("rejects a version below 7000", () => {
    const buf = buildFBXBinary({ version: 6100, nodes: [] });
    expectFBXError(() => parseFBXBinary(buf, LIMITS), "FBX_VERSION_UNSUPPORTED");
  });

  it("rejects a version above 7700", () => {
    const buf = buildFBXBinary({ version: 8000, nodes: [] });
    expectFBXError(() => parseFBXBinary(buf, LIMITS), "FBX_VERSION_UNSUPPORTED");
  });

  it("accepts version 7000 (lower bound) and 7700 (upper bound)", () => {
    expect(() => parseFBXBinary(buildFBXBinary({ version: 7000, nodes: [] }), LIMITS)).not.toThrow();
    expect(() => parseFBXBinary(buildFBXBinary({ version: 7700, nodes: [] }), LIMITS)).not.toThrow();
  });

  it("uses 32-bit record fields below FBX 7500", () => {
    const doc = parseFBXBinary(buildFBXBinary({ version: 7499, nodes: [{ name: "X" }] }), LIMITS);
    expect(doc.uses64BitRecords).toBe(false);
  });

  it("uses 64-bit record fields at FBX 7500 and above", () => {
    const doc = parseFBXBinary(buildFBXBinary({ version: 7500, nodes: [{ name: "X" }] }), LIMITS);
    expect(doc.uses64BitRecords).toBe(true);
    expect(doc.nodes[0].name).toBe("X");
  });
});

describe("parseFBXBinary — node records", () => {
  it("parses nested children correctly", () => {
    const buf = buildFBXBinary({
      nodes: [
        {
          name: "Objects",
          children: [
            { name: "Model", properties: [{ type: "S", value: "Cube" }] },
            { name: "Geometry", properties: [{ type: "S", value: "Mesh" }] },
          ],
        },
      ],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(doc.nodes[0].children).toHaveLength(2);
    expect(doc.nodes[0].children[0].name).toBe("Model");
    expect(doc.nodes[0].children[1].name).toBe("Geometry");
  });

  it("parses deeply nested (but within-limit) children", () => {
    let leaf: import("./test-fixtures").FixtureNode = { name: "Leaf" };
    for (let i = 0; i < 20; i++) leaf = { name: `N${i}`, children: [leaf] };
    const doc = parseFBXBinary(buildFBXBinary({ nodes: [leaf] }), LIMITS);
    let node = doc.nodes[0];
    for (let i = 0; i < 20; i++) node = node.children[0];
    expect(node.name).toBe("Leaf");
  });

  it("parses multiple top-level nodes independent of order", () => {
    const doc = parseFBXBinary(buildFBXBinary({ nodes: [{ name: "A" }, { name: "B" }, { name: "C" }] }), LIMITS);
    expect(doc.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
  });

  it("tolerates a missing top-level null-record terminator (clean EOF)", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "A" }], omitTopLevelTerminator: true });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(doc.nodes.map((n) => n.name)).toEqual(["A"]);
  });

  it("rejects truncated node data (cut mid-property-list)", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "A", properties: [{ type: "S", value: "a fairly long string value" }] }] });
    const truncated = truncateBuffer(buf, buf.byteLength - 5);
    expectFBXError(() => parseFBXBinary(truncated, LIMITS), "FBX_NODE_TRUNCATED");
  });

  it("rejects truncated data at the exact root-level decision point (a handful of stray bytes)", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "A" }] });
    // Cut off partway through the top-level null record's 13 zero bytes.
    const truncated = truncateBuffer(buf, buf.byteLength - 5);
    expectFBXError(() => parseFBXBinary(truncated, LIMITS), "FBX_NODE_TRUNCATED");
  });

  it("rejects excessive tree depth", () => {
    const limits: FBXLimits = { ...LIMITS, maxTreeDepth: 5 };
    let leaf: import("./test-fixtures").FixtureNode = { name: "Leaf" };
    for (let i = 0; i < 10; i++) leaf = { name: `N${i}`, children: [leaf] };
    expectFBXError(() => parseFBXBinary(buildFBXBinary({ nodes: [leaf] }), limits), "FBX_NODE_DEPTH_EXCEEDED");
  });

  it("rejects excessive node count", () => {
    const limits: FBXLimits = { ...LIMITS, maxNodeCount: 3 };
    const buf = buildFBXBinary({ nodes: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] });
    expectFBXError(() => parseFBXBinary(buf, limits), "FBX_NODE_COUNT_EXCEEDED");
  });

  it("rejects excessive property count on one node", () => {
    const limits: FBXLimits = { ...LIMITS, maxPropertiesPerNode: 2 };
    const buf = buildFBXBinary({ nodes: [{ name: "A", properties: [{ type: "I", value: 1 }, { type: "I", value: 2 }, { type: "I", value: 3 }] }] });
    expectFBXError(() => parseFBXBinary(buf, limits), "FBX_PROPERTY_COUNT_EXCEEDED");
  });

  it("round-trips every scalar property type", () => {
    const buf = buildFBXBinary({
      nodes: [
        {
          name: "P",
          properties: [
            { type: "Y", value: -123 },
            { type: "C", value: true },
            { type: "I", value: -70000 },
            { type: "F", value: 1.5 },
            { type: "D", value: 3.14159265 },
            { type: "L", value: 123456789012345n },
          ],
        },
      ],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    const props = doc.nodes[0].properties;
    expect(props[0]).toEqual({ type: "Y", value: -123 });
    expect(props[1]).toEqual({ type: "C", value: true });
    expect(props[2]).toEqual({ type: "I", value: -70000 });
    expect(props[3].type).toBe("F");
    expect(props[3].value as number).toBeCloseTo(1.5, 5);
    expect(props[4].type).toBe("D");
    expect(props[4].value as number).toBeCloseTo(3.14159265, 8);
    expect(props[5]).toEqual({ type: "L", value: 123456789012345n });
  });

  it("round-trips string and raw properties", () => {
    const buf = buildFBXBinary({
      nodes: [{ name: "P", properties: [{ type: "S", value: "Hello, FBX" }, { type: "R", value: new Uint8Array([1, 2, 3, 255]) }] }],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(doc.nodes[0].properties[0]).toEqual({ type: "S", value: "Hello, FBX" });
    const raw = doc.nodes[0].properties[1];
    expect(raw.type).toBe("R");
    expect(Array.from(raw.value as Uint8Array)).toEqual([1, 2, 3, 255]);
  });
});

describe("parseFBXBinary — typed arrays (uncompressed and zlib-compressed)", () => {
  it("round-trips an uncompressed float32 array", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "f", value: [1, 2, 3.5, -4] }] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    const prop = doc.nodes[0].properties[0];
    expect(prop.type).toBe("f");
    expect(Array.from(prop.value as Float32Array).map((v) => Math.round(v * 10) / 10)).toEqual([1, 2, 3.5, -4]);
  });

  it("round-trips a zlib-compressed float64 array", () => {
    const values = Array.from({ length: 200 }, (_, i) => i * 0.5);
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "d", value: values, compress: true }] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    const prop = doc.nodes[0].properties[0];
    expect(prop.type).toBe("d");
    expect(Array.from(prop.value as Float64Array)).toEqual(values);
  });

  it("round-trips a zlib-compressed int32 array", () => {
    const values = Array.from({ length: 50 }, (_, i) => i - 25);
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "i", value: values, compress: true }] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(Array.from(doc.nodes[0].properties[0].value as Int32Array)).toEqual(values);
  });

  it("round-trips an int64 array", () => {
    const values = [1n, -2n, 9007199254740993n];
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "l", value: values }] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(Array.from(doc.nodes[0].properties[0].value as BigInt64Array)).toEqual(values);
  });

  it("round-trips a bool array", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "b", value: [1, 0, 1, 1, 0] }] }] });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(Array.from(doc.nodes[0].properties[0].value as Uint8Array)).toEqual([1, 0, 1, 1, 0]);
  });

  it("rejects a malformed zlib stream", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "d", value: [1, 2, 3, 4, 5, 6, 7, 8], compress: true }] }] });
    const bytes = new Uint8Array(buf.slice(0));
    // Header(27) + endOffset(4) + numProps(4) + propListLen(4) + nameLen(1) + name("P"=1) + type('d'=1) + ArrayLength(4) + Encoding(4) + CompressedLength(4) = payload start.
    const payloadStart = 27 + 4 + 4 + 4 + 1 + 1 + 1 + 4 + 4 + 4;
    for (let i = payloadStart + 2; i < payloadStart + 6; i++) bytes[i] = bytes[i] ^ 0xff;
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_ARRAY_DECOMPRESSION_FAILED");
  });

  it("rejects a decompressed-size mismatch (declared ArrayLength doesn't match what the stream actually inflates to)", () => {
    // Build a valid compressed 10-element array, then patch ArrayLength up front to claim 11 elements instead.
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "d", value: Array.from({ length: 10 }, (_, i) => i), compress: true }] }] });
    const bytes = new Uint8Array(buf.slice(0));
    // Header: magic(23) + version(4) + endOffset(4) + numProps(4) + propListLen(4) + nameLen(1) + name("P"=1) = 41, then type byte 'd' at 41, ArrayLength u32 at 42.
    const arrayLengthOffset = 23 + 4 + 4 + 4 + 4 + 1 + 1 + 1;
    new DataView(bytes.buffer).setUint32(arrayLengthOffset, 11, true);
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_ARRAY_DECOMPRESSION_FAILED");
  });

  it("rejects an array exceeding the decompressed-size ceiling before allocating", () => {
    const limits: FBXLimits = { ...LIMITS, maxDecompressedArrayBytes: 100 };
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "d", value: Array.from({ length: 50 }, (_, i) => i) }] }] });
    expectFBXError(() => parseFBXBinary(buf, limits), "FBX_ARRAY_TOO_LARGE");
  });

  it("rejects a compressed array exceeding the compressed-size ceiling", () => {
    const limits: FBXLimits = { ...LIMITS, maxCompressedArrayBytes: 10 };
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "d", value: Array.from({ length: 200 }, (_, i) => i), compress: true }] }] });
    expectFBXError(() => parseFBXBinary(buf, limits), "FBX_ARRAY_COMPRESSED_TOO_LARGE");
  });

  it("rejects an unrecognized array encoding value", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "P", properties: [{ type: "i", value: [1, 2, 3] }] }] });
    const bytes = new Uint8Array(buf.slice(0));
    const arrayLengthOffset = 23 + 4 + 4 + 4 + 4 + 1 + 1 + 1;
    new DataView(bytes.buffer).setUint32(arrayLengthOffset + 4, 99, true); // Encoding field
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_PROPERTY_INVALID");
  });
});

describe("parseFBXBinary — unsafe 64-bit offsets", () => {
  it("rejects a 64-bit EndOffset exceeding Number.MAX_SAFE_INTEGER", () => {
    const buf = buildFBXBinary({ version: 7500, nodes: [{ name: "A" }] });
    const bytes = new Uint8Array(buf.slice(0));
    // Header: magic(23) + version(4) = 27, then EndOffset (8 bytes, 64-bit) at 27.
    const view = new DataView(bytes.buffer);
    view.setBigUint64(27, 0xffffffffffffffn, true); // far beyond MAX_SAFE_INTEGER
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_UNSAFE_INTEGER");
  });

  it("rejects an EndOffset that points backward (before the record's own start)", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "Outer", children: [{ name: "Inner" }] }] });
    const bytes = new Uint8Array(buf.slice(0));
    // Outer's EndOffset field is the very first field after the header (offset 27).
    new DataView(bytes.buffer).setUint32(27, 27, true); // claim EndOffset == its own record start
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_OFFSET_INVALID");
  });

  it("rejects an EndOffset extending past the file's own length", () => {
    const buf = buildFBXBinary({ nodes: [{ name: "A" }] });
    const bytes = new Uint8Array(buf.slice(0));
    new DataView(bytes.buffer).setUint32(27, 0x7fffffff, true);
    expectFBXError(() => parseFBXBinary(bytes.buffer, LIMITS), "FBX_OFFSET_INVALID");
  });
});
