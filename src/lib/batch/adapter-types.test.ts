import { describe, expect, it } from "vitest";
import { fileExtension, matchesAcceptedExtension } from "./adapter-types";

describe("fileExtension", () => {
  it("returns the lowercase extension without the dot", () => {
    expect(fileExtension("Model.STL")).toBe("stl");
    expect(fileExtension("part.3mf")).toBe("3mf");
  });

  it("returns an empty string for a name with no extension", () => {
    expect(fileExtension("README")).toBe("");
  });

  it("uses only the FINAL extension for a multi-dot name", () => {
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });
});

describe("matchesAcceptedExtension", () => {
  it("accepts a file whose extension is in the accepted list", () => {
    expect(matchesAcceptedExtension("part.stl", ["stl"])).toBe(true);
  });

  it("rejects a file whose extension isn't in the accepted list", () => {
    expect(matchesAcceptedExtension("part.obj", ["stl"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesAcceptedExtension("part.STL", ["stl"])).toBe(true);
  });
});
