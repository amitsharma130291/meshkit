import { describe, expect, it } from "vitest";
import { scanForStaleClaims } from "./content-accuracy.mjs";

describe("scanForStaleClaims", () => {
  it("flags a guaranteed-repair claim", () => {
    expect(scanForStaleClaims("We guarantee repair of any STL file.").length).toBeGreaterThan(0);
  });
  it("flags a 100% repair claim", () => {
    expect(scanForStaleClaims("100% repair success rate.").length).toBeGreaterThan(0);
  });
  it("flags an AI-powered claim", () => {
    expect(scanForStaleClaims("Our AI-powered repair engine fixes everything.").length).toBeGreaterThan(0);
  });
  it("no longer flags 'G-code Viewer' — Phase 9 built it for real, so this Phase 7 staleness guard is retired", () => {
    expect(scanForStaleClaims("Try our new G-code Viewer today.")).toEqual([]);
  });
  it("flags a server-upload claim", () => {
    expect(scanForStaleClaims("Your file is uploaded to our server for processing.").length).toBeGreaterThan(0);
  });
  it("passes honest, disclosed copy with no findings", () => {
    const copy = "MeshWrench repairs an STL file's holes locally in your browser. Some files can't be repaired safely and are honestly reported as such.";
    expect(scanForStaleClaims(copy)).toEqual([]);
  });
  it("does not flag a negated guarantee disclaimer (\"cannot guarantee printability\")", () => {
    const copy = "It cannot guarantee printability, wall thickness, physical scale or fitness for any specific printer.";
    expect(scanForStaleClaims(copy)).toEqual([]);
  });
});
