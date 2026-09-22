import { describe, expect, it } from "vitest";
import { parseGLBContainer } from "./container";
import { DEFAULT_GLB_LIMITS, type GLBLimits } from "./types";
import { binChunk, buildGLB, expectGLBError, jsonChunk } from "./test-fixtures";

const LIMITS: GLBLimits = DEFAULT_GLB_LIMITS;

describe("parseGLBContainer", () => {
  it("parses a valid GLB 2.0 with JSON and BIN chunks", () => {
    const bin = new Uint8Array([1, 2, 3, 4]);
    const buffer = buildGLB({ json: { asset: { version: "2.0" } }, bin });
    const result = parseGLBContainer(buffer, LIMITS);
    expect(new TextDecoder().decode(result.json).trim()).toContain('"version":"2.0"');
    expect(result.bin).not.toBeNull();
    expect(Array.from(result.bin!.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it("parses a valid GLB with JSON only (no BIN chunk)", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" } } });
    const result = parseGLBContainer(buffer, LIMITS);
    expect(result.bin).toBeNull();
  });

  it("rejects a truncated header", () => {
    const buffer = new ArrayBuffer(8);
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_HEADER_TRUNCATED");
  });

  it("rejects an invalid magic value", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" } }, magic: 0xdeadbeef });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_MAGIC_INVALID");
  });

  it("rejects an unsupported version", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" } }, version: 1 });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_VERSION_UNSUPPORTED");
  });

  it("rejects an incorrect declared total length", () => {
    const buffer = buildGLB({ json: { asset: { version: "2.0" } }, declaredLength: 99999 });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_LENGTH_INVALID");
  });

  it("rejects trailing undeclared bytes", () => {
    const chunks = [jsonChunk({ asset: { version: "2.0" } })];
    let chunkBytes = 8 * chunks.length;
    for (const c of chunks) chunkBytes += c.data.length;
    // Declare a length that matches only the real chunk data, but physically append extra bytes.
    const buffer = buildGLB({ chunks, declaredLength: 12 + chunkBytes, trailingBytes: 4 });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_LENGTH_INVALID");
  });

  it("rejects a missing JSON chunk", () => {
    const buffer = buildGLB({ chunks: [binChunk(new Uint8Array([1, 2, 3, 4]))] });
    // A BIN-first chunk sequence is rejected as "JSON must be first" before
    // the missing-JSON check even needs to run.
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_JSON_CHUNK_MISSING");
  });

  it("rejects a JSON chunk that is not first", () => {
    const buffer = buildGLB({
      chunks: [binChunk(new Uint8Array([1, 2, 3, 4])), jsonChunk({ asset: { version: "2.0" } })],
    });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_JSON_CHUNK_MISSING");
  });

  it("rejects a truncated chunk", () => {
    // Declare a JSON chunk length far larger than the buffer actually contains.
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 20, true);
    view.setUint32(12, 1000, true); // chunkLength — way beyond the buffer
    view.setUint32(16, 0x4e4f534a, true); // JSON
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_CHUNK_TRUNCATED");
  });

  it("rejects a misaligned (non-4-byte-multiple) chunk length", () => {
    const buffer = new ArrayBuffer(12 + 8 + 5);
    const view = new DataView(buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, buffer.byteLength, true);
    view.setUint32(12, 5, true); // not a multiple of 4
    view.setUint32(16, 0x4e4f534a, true);
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_CHUNK_TRUNCATED");
  });

  it("rejects a duplicate JSON chunk", () => {
    const buffer = buildGLB({
      chunks: [jsonChunk({ asset: { version: "2.0" } }), jsonChunk({ asset: { version: "2.0" } })],
    });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_CHUNK_INVALID");
  });

  it("rejects a duplicate BIN chunk", () => {
    const buffer = buildGLB({
      chunks: [jsonChunk({ asset: { version: "2.0" } }), binChunk(new Uint8Array([1, 2, 3, 4])), binChunk(new Uint8Array([5, 6, 7, 8]))],
    });
    expectGLBError(() => parseGLBContainer(buffer, LIMITS), "GLB_CHUNK_INVALID");
  });

  it("ignores an unknown optional chunk type without reading beyond it", () => {
    const unknownChunk = { type: 0x12345678, data: new Uint8Array([9, 9, 9, 9]) };
    const buffer = buildGLB({ chunks: [jsonChunk({ asset: { version: "2.0" } }), unknownChunk] });
    const result = parseGLBContainer(buffer, LIMITS);
    expect(result.bin).toBeNull();
  });

  it("enforces the configurable JSON size ceiling", () => {
    const limits: GLBLimits = { ...LIMITS, maxJsonBytes: 8 };
    const buffer = buildGLB({ json: { asset: { version: "2.0" } } });
    expectGLBError(() => parseGLBContainer(buffer, limits), "GLB_FILE_TOO_LARGE");
  });

  it("enforces the configurable BIN size ceiling", () => {
    const limits: GLBLimits = { ...LIMITS, maxBinBytes: 2 };
    const buffer = buildGLB({ json: { asset: { version: "2.0" } }, bin: new Uint8Array([1, 2, 3, 4]) });
    expectGLBError(() => parseGLBContainer(buffer, limits), "GLB_FILE_TOO_LARGE");
  });

  it("enforces the configurable container size ceiling", () => {
    const limits: GLBLimits = { ...LIMITS, maxContainerBytes: 4 };
    const buffer = buildGLB({ json: { asset: { version: "2.0" } } });
    expectGLBError(() => parseGLBContainer(buffer, limits), "GLB_FILE_TOO_LARGE");
  });
});
