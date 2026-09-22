import { describe, expect, it } from "vitest";
import { normalizeExtension, validateSelectedFile, type FileValidationConfig } from "./validation";

function makeFile(name: string, size: number): File {
  const bytes = new Uint8Array(Math.max(size, 0));
  return new File([bytes], name);
}

describe("normalizeExtension", () => {
  it("lowercases and strips the leading dot", () => {
    expect(normalizeExtension("Model.STL")).toBe("stl");
  });

  it("returns an empty string when there is no extension", () => {
    expect(normalizeExtension("model")).toBe("");
  });

  it("returns an empty string for a trailing dot", () => {
    expect(normalizeExtension("model.")).toBe("");
  });
});

describe("validateSelectedFile", () => {
  const config: FileValidationConfig = { allowedExtensions: ["stl", "obj"], maxSizeBytes: 1024 };

  it("rejects unsupported extensions", () => {
    const result = validateSelectedFile(makeFile("model.glb", 100), config);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("rejects empty files", () => {
    const result = validateSelectedFile(makeFile("model.stl", 0), config);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe("EMPTY_FILE");
  });

  it("rejects files over the size limit", () => {
    const result = validateSelectedFile(makeFile("model.stl", 2048), config);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe("FILE_TOO_LARGE");
  });

  it("accepts a valid file and normalizes its extension", () => {
    const result = validateSelectedFile(makeFile("Model.STL", 512), config);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.extension).toBe("stl");
  });
});
