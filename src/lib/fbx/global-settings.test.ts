import { describe, expect, it } from "vitest";
import { parseFBXBinary } from "./binary-parser";
import { parseGlobalSettings } from "./global-settings";
import { DEFAULT_FBX_LIMITS } from "./types";
import { buildFBXBinary, globalSettingsNode, p70 } from "./test-fixtures";

function parse(entries: ReturnType<typeof p70>[]) {
  const buf = buildFBXBinary({ nodes: [globalSettingsNode(entries)] });
  const doc = parseFBXBinary(buf, DEFAULT_FBX_LIMITS);
  return parseGlobalSettings(doc.nodes[0]);
}

describe("parseGlobalSettings", () => {
  it("returns null for both when GlobalSettings is absent", () => {
    const result = parseGlobalSettings(null);
    expect(result.unitScaleFactor).toBeNull();
    expect(result.axisSystem).toBeNull();
  });

  it("reads a valid Y-up right-handed axis system and unit scale (Maya/Blender-style, meters)", () => {
    const result = parse([
      p70("UpAxis", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("UpAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("FrontAxis", "int", "Integer", "", [{ type: "I", value: 2 }]),
      p70("FrontAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("CoordAxis", "int", "Integer", "", [{ type: "I", value: 0 }]),
      p70("CoordAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("UnitScaleFactor", "double", "Number", "", [{ type: "D", value: 100 }]),
    ]);
    expect(result.axisSystem).toEqual({ upAxis: 1, upSign: 1, frontAxis: 2, frontSign: 1, coordAxis: 0, coordSign: 1 });
    expect(result.unitScaleFactor).toBe(100);
  });

  it("treats a contradictory axis system (two axes claiming the same slot) as absent", () => {
    const result = parse([
      p70("UpAxis", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("UpAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("FrontAxis", "int", "Integer", "", [{ type: "I", value: 1 }]), // same as UpAxis — contradictory
      p70("FrontAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("CoordAxis", "int", "Integer", "", [{ type: "I", value: 0 }]),
      p70("CoordAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
    ]);
    expect(result.axisSystem).toBeNull();
  });

  it("treats a partially-declared axis system (one field missing) as absent", () => {
    const result = parse([
      p70("UpAxis", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("UpAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
    ]);
    expect(result.axisSystem).toBeNull();
  });

  it("treats an invalid sign value (not ±1) as absent", () => {
    const result = parse([
      p70("UpAxis", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("UpAxisSign", "int", "Integer", "", [{ type: "I", value: 5 }]),
      p70("FrontAxis", "int", "Integer", "", [{ type: "I", value: 2 }]),
      p70("FrontAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
      p70("CoordAxis", "int", "Integer", "", [{ type: "I", value: 0 }]),
      p70("CoordAxisSign", "int", "Integer", "", [{ type: "I", value: 1 }]),
    ]);
    expect(result.axisSystem).toBeNull();
  });

  it("treats a zero or negative UnitScaleFactor as absent", () => {
    expect(parse([p70("UnitScaleFactor", "double", "Number", "", [{ type: "D", value: 0 }])]).unitScaleFactor).toBeNull();
    expect(parse([p70("UnitScaleFactor", "double", "Number", "", [{ type: "D", value: -5 }])]).unitScaleFactor).toBeNull();
  });

  it("accepts the common centimeter default (UnitScaleFactor = 1)", () => {
    expect(parse([p70("UnitScaleFactor", "double", "Number", "", [{ type: "D", value: 1 }])]).unitScaleFactor).toBe(1);
  });
});
