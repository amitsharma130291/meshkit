import { describe, expect, it } from "vitest";
import { computeGCodeChecksum, verifyChecksum } from "./checksum";

describe("computeGCodeChecksum", () => {
  it("computes the XOR of every character's char code up to (not including) '*'", () => {
    const text = "N3 G1 X0 Y0 F1500";
    let expected = 0;
    for (const ch of text) expected ^= ch.charCodeAt(0);
    expect(computeGCodeChecksum(text)).toBe(expected);
  });

  it("is deterministic", () => {
    expect(computeGCodeChecksum("N3 G1 X0 Y0")).toBe(computeGCodeChecksum("N3 G1 X0 Y0"));
  });

  it("is sensitive to any single-character change (a real corruption detector)", () => {
    expect(computeGCodeChecksum("N3 G1 X0 Y0")).not.toBe(computeGCodeChecksum("N3 G1 X0 Y1"));
  });
});

describe("verifyChecksum", () => {
  it("reports 'valid' when the declared checksum matches the computed one", () => {
    const body = "N10 G1 X10 Y20";
    const checksum = computeGCodeChecksum(body);
    const line = `${body}*${checksum}`;
    const result = verifyChecksum(line);
    expect(result.status).toBe("valid");
    expect(result.declared).toBe(checksum);
    expect(result.computed).toBe(checksum);
  });

  it("reports 'mismatched' when the declared checksum doesn't match", () => {
    const body = "N10 G1 X10 Y20";
    const correct = computeGCodeChecksum(body);
    const line = `${body}*${correct + 1}`;
    const result = verifyChecksum(line);
    expect(result.status).toBe("mismatched");
    expect(result.computed).toBe(correct);
    expect(result.declared).toBe(correct + 1);
  });

  it("reports 'missing' when the line has no checksum at all", () => {
    const result = verifyChecksum("N10 G1 X10 Y20");
    expect(result.status).toBe("missing");
    expect(result.declared).toBeNull();
  });

  it("computes the checksum only over the text before '*', never including the checksum digits themselves", () => {
    const body = "N1 G1 X1";
    const checksum = computeGCodeChecksum(body);
    const result = verifyChecksum(`${body}*${checksum}`);
    expect(result.computed).toBe(checksum);
  });

  it("treats a malformed checksum suffix (non-numeric) as mismatched, never throwing", () => {
    expect(() => verifyChecksum("N1 G1 X1*abc")).not.toThrow();
    const result = verifyChecksum("N1 G1 X1*abc");
    expect(result.status).toBe("mismatched");
  });
});
