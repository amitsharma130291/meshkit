import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { decodeFBXMaterial } from "./materials";
import { DEFAULT_FBX_LIMITS } from "./types";
import { buildFBXBinary, materialNode, p70 } from "./test-fixtures";

const LIMITS = DEFAULT_FBX_LIMITS;

describe("decodeFBXMaterial", () => {
  it("reads a Lambert material's diffuse color and factor", () => {
    const buf = buildFBXBinary({
      nodes: [materialNode(1n, "Red", "Lambert", [p70("DiffuseColor", "ColorRGB", "Color", "A", [{ type: "D", value: 1 }, { type: "D", value: 0 }, { type: "D", value: 0 }])])],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    const mat = decodeFBXMaterial("Red", doc.nodes[0]);
    expect(mat.shadingModel).toBe("Lambert");
    expect(mat.diffuseColor).toEqual([1, 0, 0]);
  });

  it("reads a Phong material's diffuse factor", () => {
    const buf = buildFBXBinary({ nodes: [materialNode(1n, "M", "Phong", [p70("DiffuseFactor", "Number", "", "A", [{ type: "D", value: 0.5 }])])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const mat = decodeFBXMaterial("M", doc.nodes[0]);
    expect(mat.diffuseFactor).toBe(0.5);
  });

  it("derives opacity from TransparencyFactor when Opacity is absent", () => {
    const buf = buildFBXBinary({ nodes: [materialNode(1n, "M", "Lambert", [p70("TransparencyFactor", "Number", "", "A", [{ type: "D", value: 0.25 }])])] });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(decodeFBXMaterial("M", doc.nodes[0]).opacity).toBeCloseTo(0.75, 5);
  });

  it("prefers an explicit Opacity property over TransparencyFactor", () => {
    const buf = buildFBXBinary({
      nodes: [materialNode(1n, "M", "Lambert", [p70("Opacity", "Number", "", "A", [{ type: "D", value: 0.9 }]), p70("TransparencyFactor", "Number", "", "A", [{ type: "D", value: 0.5 }])])],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(decodeFBXMaterial("M", doc.nodes[0]).opacity).toBeCloseTo(0.9, 5);
  });

  it("defaults to fully opaque, neutral gray, and full diffuse factor when nothing is declared", () => {
    const buf = buildFBXBinary({ nodes: [materialNode(1n, "M", "unknown", [])] });
    const doc = parseFBXBinary(buf, LIMITS);
    const mat = decodeFBXMaterial("M", doc.nodes[0]);
    expect(mat.opacity).toBe(1);
    expect(mat.diffuseColor).toEqual([0.8, 0.8, 0.8]);
    expect(mat.diffuseFactor).toBe(1);
  });

  it("clamps an out-of-range color/opacity value into [0, 1]", () => {
    const buf = buildFBXBinary({
      nodes: [materialNode(1n, "M", "Lambert", [p70("DiffuseColor", "ColorRGB", "Color", "A", [{ type: "D", value: 1.5 }, { type: "D", value: -0.5 }, { type: "D", value: 0.5 }])])],
    });
    const doc = parseFBXBinary(buf, LIMITS);
    expect(decodeFBXMaterial("M", doc.nodes[0]).diffuseColor).toEqual([1, 0, 0.5]);
  });
});
