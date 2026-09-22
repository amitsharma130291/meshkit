import { describe, expect, it } from "vitest";
import { decodeOBJText, iterateLogicalLines, tokenizeLine } from "./tokenizer";
import { expectOBJError, textToBuffer } from "./test-fixtures";
import { DEFAULT_OBJ_LIMITS } from "./types";

describe("decodeOBJText", () => {
  it("decodes plain UTF-8 text", () => {
    expect(decodeOBJText(textToBuffer("v 0 0 0"), DEFAULT_OBJ_LIMITS)).toBe("v 0 0 0");
  });

  it("strips a UTF-8 BOM", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("v 1 2 3")]);
    expect(decodeOBJText(withBom.buffer, DEFAULT_OBJ_LIMITS)).toBe("v 1 2 3");
  });

  it("rejects null bytes", () => {
    const bytes = new Uint8Array([0x76, 0x20, 0x00, 0x31]);
    expectOBJError(() => decodeOBJText(bytes.buffer, DEFAULT_OBJ_LIMITS), "OBJ_TEXT_DECODE_FAILED");
  });

  it("rejects invalid UTF-8", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    expectOBJError(() => decodeOBJText(bytes.buffer, DEFAULT_OBJ_LIMITS), "OBJ_TEXT_DECODE_FAILED");
  });

  it("rejects a buffer larger than the configured text ceiling", () => {
    const limits = { ...DEFAULT_OBJ_LIMITS, maxTextBytes: 4 };
    expectOBJError(() => decodeOBJText(textToBuffer("way too long"), limits), "OBJ_FILE_TOO_LARGE");
  });
});

describe("iterateLogicalLines", () => {
  it("normalizes LF, CRLF and CR line endings", () => {
    const text = "v 1 1 1\nv 2 2 2\r\nv 3 3 3\rv 4 4 4";
    const lines = [...iterateLogicalLines(text)].map((l) => l.raw);
    expect(lines).toEqual(["v 1 1 1", "v 2 2 2", "v 3 3 3", "v 4 4 4"]);
  });

  it("merges a trailing-backslash continuation with the next line", () => {
    const text = "f 1 2 \\\n3 4";
    const lines = [...iterateLogicalLines(text)];
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe("f 1 2  3 4");
    expect(lines[0].lineNumber).toBe(1);
  });

  it("reports the first physical line number of a logical line", () => {
    const text = "v 1 1 1\nv 2 2 2";
    const lines = [...iterateLogicalLines(text)];
    expect(lines[1].lineNumber).toBe(2);
  });
});

describe("tokenizeLine", () => {
  it("ignores blank lines", () => {
    expect(tokenizeLine("")).toBeNull();
    expect(tokenizeLine("   ")).toBeNull();
  });

  it("ignores full-line comments", () => {
    expect(tokenizeLine("# a comment")).toBeNull();
  });

  it("strips a trailing comment from a data line", () => {
    expect(tokenizeLine("v 1 2 3 # note")).toEqual({ keyword: "v", args: ["1", "2", "3"] });
  });

  it("tolerates leading and repeated whitespace", () => {
    expect(tokenizeLine("   v   1   2   3  ")).toEqual({ keyword: "v", args: ["1", "2", "3"] });
  });
});
