import { describe, expect, it } from "vitest";
import { expectThreeMFError } from "./test-fixtures";
import { parseThreeMFColorHex, resolvePropertyColor, srgbChannelToLinear, type ThreeMFColorResources } from "./viewer-colors";

describe("parseThreeMFColorHex", () => {
  it("parses a 6-digit RGB value with alpha defaulting to 1", () => {
    const color = parseThreeMFColorHex("#FF0000");
    expect(color).toEqual({ r: 1, g: 0, b: 0, alpha: 1 });
  });

  it("parses an 8-digit RGBA value", () => {
    const color = parseThreeMFColorHex("#00FF0080");
    expect(color.r).toBe(0);
    expect(color.g).toBe(1);
    expect(color.b).toBe(0);
    expect(color.alpha).toBeCloseTo(128 / 255, 5);
  });

  it("accepts lowercase hex digits", () => {
    expect(parseThreeMFColorHex("#abcdef")).toEqual({
      r: 0xab / 255,
      g: 0xcd / 255,
      b: 0xef / 255,
      alpha: 1,
    });
  });

  it("rejects a value with an invalid length", () => {
    expectThreeMFError(() => parseThreeMFColorHex("#FFF"), "THREEMF_COLOR_REFERENCE_INVALID");
    expectThreeMFError(() => parseThreeMFColorHex("#FF00FF0"), "THREEMF_COLOR_REFERENCE_INVALID");
  });

  it("rejects a value with non-hex characters", () => {
    expectThreeMFError(() => parseThreeMFColorHex("#GGGGGG"), "THREEMF_COLOR_REFERENCE_INVALID");
  });

  it("rejects a value missing the leading #", () => {
    expectThreeMFError(() => parseThreeMFColorHex("FF0000"), "THREEMF_COLOR_REFERENCE_INVALID");
  });
});

describe("srgbChannelToLinear", () => {
  it("maps 0 to 0 and 1 to 1", () => {
    expect(srgbChannelToLinear(0)).toBe(0);
    expect(srgbChannelToLinear(1)).toBeCloseTo(1, 5);
  });

  it("is monotonically increasing", () => {
    expect(srgbChannelToLinear(0.2)).toBeLessThan(srgbChannelToLinear(0.5));
    expect(srgbChannelToLinear(0.5)).toBeLessThan(srgbChannelToLinear(0.8));
  });
});

describe("resolvePropertyColor", () => {
  const resources: ThreeMFColorResources = {
    basematerials: new Map([
      [
        "1",
        [
          { name: "Red", color: { r: 1, g: 0, b: 0, alpha: 1 } },
          { name: "NoColor", color: null },
        ],
      ],
    ]),
    colorgroups: new Map([["2", [{ color: { r: 0, g: 1, b: 0, alpha: 1 } }, { color: { r: 0, g: 0, b: 1, alpha: 1 } }]]]),
    textureGroupIds: new Set(["3"]),
  };

  it("returns none when pid or pindex is missing", () => {
    expect(resolvePropertyColor(resources, undefined, 0)).toEqual({ kind: "none" });
    expect(resolvePropertyColor(resources, "1", undefined)).toEqual({ kind: "none" });
  });

  it("resolves a base-material reference", () => {
    const result = resolvePropertyColor(resources, "1", 0);
    expect(result.kind).toBe("color");
    if (result.kind === "color") {
      expect(result.color.r).toBe(1);
      expect(result.ref).toBe("Material 1:0");
    }
  });

  it("resolves a color-group reference", () => {
    const result = resolvePropertyColor(resources, "2", 1);
    expect(result.kind).toBe("color");
    if (result.kind === "color") {
      expect(result.color.b).toBe(1);
      expect(result.ref).toBe("Colors 2:1");
    }
  });

  it("reports invalid for a base material with no displaycolor", () => {
    expect(resolvePropertyColor(resources, "1", 1)).toEqual({ kind: "invalid" });
  });

  it("reports invalid for an out-of-range pindex", () => {
    expect(resolvePropertyColor(resources, "2", 5)).toEqual({ kind: "invalid" });
  });

  it("reports invalid for a pid that doesn't resolve to any known resource", () => {
    expect(resolvePropertyColor(resources, "999", 0)).toEqual({ kind: "invalid" });
  });

  it("reports texture for a pid that resolves to a texture group", () => {
    expect(resolvePropertyColor(resources, "3", 0)).toEqual({ kind: "texture" });
  });
});
