import { describe, expect, it } from "vitest";
import { detectSTLEncoding } from "./detect";
import { buildAsciiSTLText, buildBinarySTLBuffer, sampleTriangle, textToBuffer } from "./test-fixtures";

describe("detectSTLEncoding", () => {
  it("detects a normal binary STL", () => {
    const buffer = buildBinarySTLBuffer([sampleTriangle(), sampleTriangle()]);
    expect(detectSTLEncoding(buffer)).toEqual({ encoding: "binary", confident: true });
  });

  it("detects a binary STL whose 80-byte header text begins with the word 'solid'", () => {
    // The historical footgun this function must avoid: binary STL headers
    // are free-form text, and many binary exporters write "solid ..." there.
    const buffer = buildBinarySTLBuffer([sampleTriangle()], "solid exported by SomeCAD tool v2");
    expect(detectSTLEncoding(buffer)).toEqual({ encoding: "binary", confident: true });
  });

  it("detects a normal ASCII STL", () => {
    const buffer = textToBuffer(buildAsciiSTLText([sampleTriangle()]));
    expect(detectSTLEncoding(buffer)).toEqual({ encoding: "ascii", confident: true });
  });

  it("returns an unconfident binary guess for input that matches neither signal", () => {
    const buffer = textToBuffer("this is not an STL file at all, just some plain text content padding it out");
    const result = detectSTLEncoding(buffer);
    expect(result.confident).toBe(false);
  });
});
