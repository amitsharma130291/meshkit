import { describe, expect, it } from "vitest";
import { FilenameCollisionTracker, buildOutputFilename, sanitizeFilenameStem } from "./filenames";

describe("sanitizeFilenameStem", () => {
  it("strips a leading path (forward slashes)", () => {
    expect(sanitizeFilenameStem("some/dir/part.stl")).toBe("part.stl");
  });

  it("strips a leading path (backslashes, Windows-style)", () => {
    expect(sanitizeFilenameStem("C:\\Users\\amits\\part.stl")).toBe("part.stl");
  });

  it("strips control characters", () => {
    expect(sanitizeFilenameStem("part\x00\x1F\x7F.stl")).toBe("part.stl");
  });

  it("preserves Unicode characters", () => {
    expect(sanitizeFilenameStem("零件模型.stl")).toBe("零件模型.stl");
  });

  it("rewrites a reserved Windows device name", () => {
    expect(sanitizeFilenameStem("CON.stl")).not.toBe("CON.stl");
    expect(sanitizeFilenameStem("con.stl").toUpperCase()).not.toBe("CON.STL");
  });

  it("falls back to a safe default for an empty or dot-only name", () => {
    expect(sanitizeFilenameStem("")).toBeTruthy();
    expect(sanitizeFilenameStem("...")).toBeTruthy();
  });

  it("truncates a very long name", () => {
    const long = "x".repeat(500) + ".stl";
    const result = sanitizeFilenameStem(long);
    expect(result.length).toBeLessThan(200);
  });
});

describe("buildOutputFilename — deterministic, collision-safe naming", () => {
  it("replaces the output extension", () => {
    const tracker = new FilenameCollisionTracker();
    expect(buildOutputFilename("model.3mf", "stl", tracker)).toBe("model.stl");
  });

  it("produces the documented ' (2)', ' (3)' collision suffixes for repeated source names", () => {
    const tracker = new FilenameCollisionTracker();
    expect(buildOutputFilename("part.stl", "obj", tracker)).toBe("part.obj");
    expect(buildOutputFilename("part.stl", "obj", tracker)).toBe("part (2).obj");
    expect(buildOutputFilename("part.stl", "obj", tracker)).toBe("part (3).obj");
  });

  it("detects collisions case-insensitively", () => {
    const tracker = new FilenameCollisionTracker();
    expect(buildOutputFilename("Part.stl", "obj", tracker)).toBe("Part.obj");
    expect(buildOutputFilename("part.stl", "obj", tracker)).toBe("part (2).obj");
  });

  it("never trusts a browser-provided relative path for output naming", () => {
    const tracker = new FilenameCollisionTracker();
    expect(buildOutputFilename("../../etc/passwd.stl", "obj", tracker)).toBe("passwd.obj");
  });

  it("is deterministic given the same input sequence", () => {
    const namesA = [buildOutputFilename("part.stl", "obj", new FilenameCollisionTracker())];
    const trackerB = new FilenameCollisionTracker();
    const namesB = [buildOutputFilename("part.stl", "obj", trackerB), buildOutputFilename("part.stl", "obj", trackerB)];
    expect(namesA[0]).toBe("part.obj");
    expect(namesB).toEqual(["part.obj", "part (2).obj"]);
  });
});
