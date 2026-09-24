import { describe, expect, it } from "vitest";
import { tokenizeLine, DEFAULT_MAX_COMMENT_LENGTH } from "./tokenizer";

describe("tokenizeLine — basic words", () => {
  it("tokenizes a simple move with spaces", () => {
    const t = tokenizeLine("G1 X10 Y20 F1500");
    expect(t.words).toEqual([
      { letter: "G", raw: "1", value: 1, finite: true },
      { letter: "X", raw: "10", value: 10, finite: true },
      { letter: "Y", raw: "20", value: 20, finite: true },
      { letter: "F", raw: "1500", value: 1500, finite: true },
    ]);
  });

  it("tokenizes command words with no mandatory spaces", () => {
    const t = tokenizeLine("G1X10Y20");
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X", "Y"]);
    expect(t.words.map((w) => w.value)).toEqual([1, 10, 20]);
  });

  it("is case-insensitive on command letters, normalizing to uppercase", () => {
    const t = tokenizeLine("g1 x10 y20");
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X", "Y"]);
  });

  it("handles tabs as whitespace separators", () => {
    const t = tokenizeLine("G1\tX10\tY20");
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X", "Y"]);
  });

  it("reports a blank line (no words, no line number) as isBlank", () => {
    expect(tokenizeLine("").isBlank).toBe(true);
    expect(tokenizeLine("   ").isBlank).toBe(true);
  });

  it("a comment-only line is blank of words but still carries the comment", () => {
    const t = tokenizeLine("; just a comment");
    expect(t.isBlank).toBe(true);
    expect(t.comment).toEqual({ kind: "semicolon", text: " just a comment", truncated: false });
  });
});

describe("tokenizeLine — numeric grammar", () => {
  it("parses signed integers", () => {
    expect(tokenizeLine("X-5").words[0]).toEqual({ letter: "X", raw: "-5", value: -5, finite: true });
    expect(tokenizeLine("X+5").words[0]).toEqual({ letter: "X", raw: "+5", value: 5, finite: true });
  });

  it("parses decimals", () => {
    expect(tokenizeLine("X1.5").words[0].value).toBe(1.5);
  });

  it("parses leading decimals with no digit before the point", () => {
    expect(tokenizeLine("X.5").words[0].value).toBe(0.5);
  });

  it("parses negative leading decimals", () => {
    expect(tokenizeLine("X-.5").words[0].value).toBe(-0.5);
  });

  it("parses scientific notation", () => {
    expect(tokenizeLine("X1e-3").words[0].value).toBeCloseTo(0.001, 10);
    expect(tokenizeLine("X1E3").words[0].value).toBe(1000);
  });

  it("flags a numeric token whose exponent overflows to Infinity as non-finite", () => {
    const w = tokenizeLine("X1e400").words[0];
    expect(w.finite).toBe(false);
    expect(Number.isFinite(w.value)).toBe(false);
  });

  it("flags a bare letter with no following number as malformed (null value)", () => {
    const t = tokenizeLine("G1 X Y10");
    const x = t.words.find((w) => w.letter === "X")!;
    expect(x.value).toBeNull();
    expect(t.malformedTokenCount).toBeGreaterThan(0);
  });

  it("does not crash on a malformed multi-dot number, and reports it as malformed", () => {
    const t = tokenizeLine("X1.2.3");
    expect(t.malformedTokenCount).toBeGreaterThan(0);
    expect(t.words[0].letter).toBe("X");
    expect(t.words[0].value).toBe(1.2); // the maximal valid numeric span is consumed
  });

  it("keeps duplicate parameters in order rather than silently dropping one", () => {
    const t = tokenizeLine("G1 X1 X2");
    const xs = t.words.filter((w) => w.letter === "X");
    expect(xs.map((w) => w.value)).toEqual([1, 2]);
  });
});

describe("tokenizeLine — line numbers and checksums", () => {
  it("parses a leading line number as N123", () => {
    const t = tokenizeLine("N123 G1 X10");
    expect(t.lineNumber).toBe(123);
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X"]);
  });

  it("parses a trailing checksum as *42", () => {
    const t = tokenizeLine("N123 G1 X10*42");
    expect(t.checksum).toBe(42);
  });

  it("only treats N as a line number when it is the first token on the line", () => {
    const t = tokenizeLine("G1 N5 X10");
    expect(t.lineNumber).toBeNull();
    expect(t.words.map((w) => w.letter)).toEqual(["G", "N", "X"]);
  });
});

describe("tokenizeLine — comments", () => {
  it("captures a semicolon comment to end of line", () => {
    const t = tokenizeLine("G1 X10 ; move to X10");
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X"]);
    expect(t.comment).toEqual({ kind: "semicolon", text: " move to X10", truncated: false });
  });

  it("captures a parenthetical comment and keeps parsing words after it", () => {
    const t = tokenizeLine("G1 (move) X10");
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X"]);
    expect(t.comment).toEqual({ kind: "parenthetical", text: "move", truncated: false });
  });

  it("bounds an excessively long comment and flags it truncated", () => {
    const long = "a".repeat(DEFAULT_MAX_COMMENT_LENGTH + 100);
    const t = tokenizeLine(`G1 ; ${long}`);
    expect(t.comment!.truncated).toBe(true);
    expect(t.comment!.text.length).toBe(DEFAULT_MAX_COMMENT_LENGTH);
  });

  it("never lets a comment produce spurious word tokens", () => {
    const t = tokenizeLine("; G1 X10 Y20 this looks like code but isn't");
    expect(t.words).toEqual([]);
  });
});

describe("tokenizeLine — unknown/unexpected characters", () => {
  it("does not throw on a stray unexpected character and counts it as malformed", () => {
    expect(() => tokenizeLine("G1 X10 @ Y20")).not.toThrow();
    const t = tokenizeLine("G1 X10 @ Y20");
    expect(t.malformedTokenCount).toBeGreaterThan(0);
    expect(t.words.map((w) => w.letter)).toEqual(["G", "X", "Y"]);
  });

  it("accepts any letter as a word without judging whether it's a 'known' parameter (lexical layer only)", () => {
    const t = tokenizeLine("Q7");
    expect(t.words).toEqual([{ letter: "Q", raw: "7", value: 7, finite: true }]);
  });
});
