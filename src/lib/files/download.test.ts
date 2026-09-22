import { describe, expect, it } from "vitest";
import { buildConvertedFilename, buildScreenshotFilename, sanitizeDownloadBasename } from "./download";

describe("sanitizeDownloadBasename", () => {
  it("strips the extension and lowercases the name", () => {
    expect(sanitizeDownloadBasename("Bracket-Final.STL")).toBe("bracket-final");
  });

  it("replaces spaces and unsafe characters with hyphens", () => {
    expect(sanitizeDownloadBasename("my cool model (v2)!!.stl")).toBe("my-cool-model-v2");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(sanitizeDownloadBasename("  ---weird///name---.stl")).toBe("weird-name");
  });

  it("falls back to 'model' when nothing safe remains", () => {
    expect(sanitizeDownloadBasename("😀😀😀.stl")).toBe("model");
    expect(sanitizeDownloadBasename(".stl")).toBe("model");
  });

  it("has no path separators or dots in its output, ever", () => {
    const result = sanitizeDownloadBasename("../../etc/passwd.stl");
    expect(result).not.toMatch(/[./\\]/);
  });
});

describe("buildScreenshotFilename", () => {
  it("appends the meshkit-preview suffix and .png extension", () => {
    expect(buildScreenshotFilename("bracket-final.stl")).toBe("bracket-final-meshkit-preview.png");
  });
});

describe("buildConvertedFilename", () => {
  it("strips only the final source extension", () => {
    expect(buildConvertedFilename("model.3mf", "3mf", "stl")).toBe("model.stl");
  });

  it("preserves internal dots in the name", () => {
    expect(buildConvertedFilename("part.final.3mf", "3mf", "stl")).toBe("part.final.stl");
  });

  it("is case-insensitive about the source extension", () => {
    expect(buildConvertedFilename("Model.3MF", "3mf", "stl")).toBe("Model.stl");
  });

  it("leaves the name alone (plus the new extension) when the source extension is absent", () => {
    expect(buildConvertedFilename("model", "3mf", "stl")).toBe("model.stl");
  });

  it("strips path separators and control characters, and any resulting leading dots", () => {
    expect(buildConvertedFilename("../../evil.3mf", "3mf", "stl")).toBe("evil.stl");
  });

  it("prevents a hidden (leading-dot) output filename", () => {
    expect(buildConvertedFilename(".3mf", "3mf", "stl")).toBe("model.stl");
  });

  it("falls back to 'model' for an empty result", () => {
    expect(buildConvertedFilename("", "3mf", "stl")).toBe("model.stl");
  });
});
