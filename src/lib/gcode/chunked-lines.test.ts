import { describe, expect, it } from "vitest";
import { ChunkedLineDecoder, DEFAULT_MAX_LINE_LENGTH } from "./chunked-lines";

function chunksOf(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

function decodeAll(text: string, chunkSize: number): string[] {
  const decoder = new ChunkedLineDecoder();
  const lines: string[] = [];
  for (const chunk of chunksOf(text, chunkSize)) {
    for (const line of decoder.pushChunk(chunk)) lines.push(line.text);
  }
  for (const line of decoder.finish()) lines.push(line.text);
  return lines;
}

describe("ChunkedLineDecoder — LF/CRLF/final-line handling", () => {
  it("splits LF-terminated lines", () => {
    expect(decodeAll("G1 X1\nG1 X2\n", 1024)).toEqual(["G1 X1", "G1 X2"]);
  });

  it("splits CRLF-terminated lines, stripping the trailing CR", () => {
    expect(decodeAll("G1 X1\r\nG1 X2\r\n", 1024)).toEqual(["G1 X1", "G1 X2"]);
  });

  it("includes a final line with no trailing newline", () => {
    expect(decodeAll("G1 X1\nG1 X2", 1024)).toEqual(["G1 X1", "G1 X2"]);
  });

  it("produces empty-string lines for consecutive newlines (empty lines)", () => {
    expect(decodeAll("G1 X1\n\nG1 X2\n", 1024)).toEqual(["G1 X1", "", "G1 X2"]);
  });

  it("returns nothing for a completely empty input", () => {
    expect(decodeAll("", 1024)).toEqual([]);
  });
});

describe("ChunkedLineDecoder — deliberately tiny chunk sizes", () => {
  it("reconstructs lines correctly when fed one byte at a time", () => {
    expect(decodeAll("G1 X1\nG1 Y2\n", 1)).toEqual(["G1 X1", "G1 Y2"]);
  });

  it("reconstructs a newline split exactly at the chunk boundary", () => {
    const decoder = new ChunkedLineDecoder();
    const lines: string[] = [];
    for (const line of decoder.pushChunk(new TextEncoder().encode("G1 X1"))) lines.push(line.text);
    for (const line of decoder.pushChunk(new TextEncoder().encode("\nG1 X2\n"))) lines.push(line.text);
    for (const line of decoder.finish()) lines.push(line.text);
    expect(lines).toEqual(["G1 X1", "G1 X2"]);
  });

  it("reconstructs a CRLF split so the CR lands in one chunk and the LF in the next", () => {
    const decoder = new ChunkedLineDecoder();
    const lines: string[] = [];
    for (const line of decoder.pushChunk(new TextEncoder().encode("G1 X1\r"))) lines.push(line.text);
    for (const line of decoder.pushChunk(new TextEncoder().encode("\nG1 X2\r\n"))) lines.push(line.text);
    for (const line of decoder.finish()) lines.push(line.text);
    expect(lines).toEqual(["G1 X1", "G1 X2"]);
  });

  it("reconstructs a multibyte UTF-8 character split across a chunk boundary", () => {
    // "café" — é is 2 bytes (0xC3 0xA9) in UTF-8; split the encoded bytes mid-character.
    const bytes = new TextEncoder().encode("; café comment\n");
    const decoder = new ChunkedLineDecoder();
    const splitPoint = bytes.indexOf(0xa9); // land the split ONE byte into the 2-byte sequence
    const lines: string[] = [];
    for (const line of decoder.pushChunk(bytes.slice(0, splitPoint))) lines.push(line.text);
    for (const line of decoder.pushChunk(bytes.slice(splitPoint))) lines.push(line.text);
    for (const line of decoder.finish()) lines.push(line.text);
    expect(lines).toEqual(["; café comment"]);
  });
});

describe("ChunkedLineDecoder — UTF-8 BOM", () => {
  it("strips a leading UTF-8 BOM from the very first decoded text", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode("G1 X1\n");
    const combined = new Uint8Array(bom.length + body.length);
    combined.set(bom, 0);
    combined.set(body, bom.length);
    const decoder = new ChunkedLineDecoder();
    const lines: string[] = [];
    for (const line of decoder.pushChunk(combined)) lines.push(line.text);
    for (const line of decoder.finish()) lines.push(line.text);
    expect(lines).toEqual(["G1 X1"]);
  });

  it("strips a BOM that arrives split across two tiny chunks", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode("G1 X1\n");
    const decoder = new ChunkedLineDecoder();
    const lines: string[] = [];
    for (const line of decoder.pushChunk(bom.slice(0, 1))) lines.push(line.text);
    for (const line of decoder.pushChunk(bom.slice(1))) lines.push(line.text);
    for (const line of decoder.pushChunk(body)) lines.push(line.text);
    for (const line of decoder.finish()) lines.push(line.text);
    expect(lines).toEqual(["G1 X1"]);
  });
});

describe("ChunkedLineDecoder — excessively long lines", () => {
  it("truncates a line longer than the configured ceiling and flags it, then resyncs on the next newline", () => {
    const decoder = new ChunkedLineDecoder({ maxLineLength: 10 });
    const huge = "G1 X" + "1".repeat(50) + "\nG1 X2\n";
    const lines: { text: string; truncated: boolean }[] = [];
    for (const line of decoder.pushChunk(new TextEncoder().encode(huge))) lines.push(line);
    for (const line of decoder.finish()) lines.push(line);
    expect(lines.length).toBe(2);
    expect(lines[0].truncated).toBe(true);
    expect(lines[0].text.length).toBeLessThanOrEqual(10);
    expect(lines[1]).toEqual({ text: "G1 X2", truncated: false });
  });

  it("does not accumulate unbounded memory across many chunks of one line with no newline yet", () => {
    const decoder = new ChunkedLineDecoder({ maxLineLength: 10 });
    for (let i = 0; i < 1000; i++) {
      decoder.pushChunk(new TextEncoder().encode("X".repeat(100)));
    }
    // internal pending buffer must never be allowed to grow proportional to total bytes fed
    expect(decoder.pendingBufferLength()).toBeLessThan(1000);
  });

  it("uses a sane default ceiling when none is configured", () => {
    expect(DEFAULT_MAX_LINE_LENGTH).toBeGreaterThan(100);
  });

  it("never truncates ordinary short lines just because many of them arrive batched in one chunk bigger than the ceiling", () => {
    // A "too long" line is a property of that ONE line, never of how much
    // unrelated, already-complete text happens to be queued up behind it
    // in the same chunk. 2000 short lines (~10 chars each) batched into a
    // single push totals ~20,000 chars — bigger than the 15-char ceiling —
    // but not one individual line is actually too long.
    const decoder = new ChunkedLineDecoder({ maxLineLength: 15 });
    const lineCount = 2000;
    const text = "G1 X1 Y1\n".repeat(lineCount);
    const lines = decoder.pushChunk(new TextEncoder().encode(text));
    for (const line of decoder.finish()) lines.push(line);
    expect(lines.length).toBe(lineCount);
    expect(lines.every((l) => l.text === "G1 X1 Y1" && !l.truncated)).toBe(true);
  });
});

describe("ChunkedLineDecoder — cancellation-friendly (no async work itself)", () => {
  it("pushChunk and finish are synchronous, so a caller's own loop can check cancellation between calls", () => {
    const decoder = new ChunkedLineDecoder();
    const result = decoder.pushChunk(new TextEncoder().encode("G1 X1\n"));
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("ChunkedLineDecoder — linear-time extraction (not quadratic in lines-per-chunk)", () => {
  it("extracts many short lines from one large chunk in roughly linear time", () => {
    const lineCount = 50_000;
    const text = "G1 X50 Y99 E0.1 F1200\n".repeat(lineCount);
    const decoder = new ChunkedLineDecoder();
    const start = performance.now();
    const lines = decoder.pushChunk(new TextEncoder().encode(text));
    const elapsedMs = performance.now() - start;
    expect(lines.length).toBe(lineCount);
    // A decoder that re-slices its whole pending buffer once per extracted
    // line degrades to O(linesPerChunk^2) and takes many seconds here; a
    // linear-time implementation finishes in well under a second.
    expect(elapsedMs).toBeLessThan(1000);
  });
});
