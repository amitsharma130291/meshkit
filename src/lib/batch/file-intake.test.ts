import { describe, expect, it } from "vitest";
import { validateIntake, DEFAULT_FILE_INTAKE_LIMITS } from "./file-intake";

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "model/stl" });
}

describe("validateIntake — file-type filtering per operation", () => {
  it("accepts files matching the operation's accepted extensions", () => {
    const result = validateIntake([makeFile("a.stl", 100)], ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(result.accepted.map((f) => f.name)).toEqual(["a.stl"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects a file whose extension doesn't match, with the documented reason code", () => {
    const result = validateIntake([makeFile("a.obj", 100)], ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("BATCH_UNSUPPORTED_FORMAT");
  });
});

describe("validateIntake — per-file byte ceiling", () => {
  it("rejects a file over the individual size ceiling", () => {
    const result = validateIntake([makeFile("a.stl", 5000)], ["stl"], { ...DEFAULT_FILE_INTAKE_LIMITS, maxIndividualBytes: 1000 });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("BATCH_FILE_TOO_LARGE");
  });
});

describe("validateIntake — file count ceiling", () => {
  it("accepts up to the ceiling and rejects the rest with BATCH_QUEUE_FULL", () => {
    const files = [makeFile("a.stl", 10), makeFile("b.stl", 10), makeFile("c.stl", 10)];
    const result = validateIntake(files, ["stl"], { ...DEFAULT_FILE_INTAKE_LIMITS, maxFileCount: 2 });
    expect(result.accepted.map((f) => f.name)).toEqual(["a.stl", "b.stl"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("BATCH_QUEUE_FULL");
  });

  it("accounts for files already queued when applying the count ceiling", () => {
    const files = [makeFile("a.stl", 10)];
    const result = validateIntake(files, ["stl"], { ...DEFAULT_FILE_INTAKE_LIMITS, maxFileCount: 2 }, { alreadyQueuedCount: 2 });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("BATCH_QUEUE_FULL");
  });
});

describe("validateIntake — total input-byte ceiling", () => {
  it("accepts files until the running total would exceed the ceiling, rejecting the rest", () => {
    const files = [makeFile("a.stl", 600), makeFile("b.stl", 600)];
    const result = validateIntake(files, ["stl"], { ...DEFAULT_FILE_INTAKE_LIMITS, maxTotalBytes: 1000 });
    expect(result.accepted.map((f) => f.name)).toEqual(["a.stl"]);
    expect(result.rejected[0].reason).toBe("BATCH_TOTAL_SIZE_EXCEEDED");
  });

  it("accounts for bytes already queued when applying the total ceiling", () => {
    const files = [makeFile("a.stl", 600)];
    const result = validateIntake(files, ["stl"], { ...DEFAULT_FILE_INTAKE_LIMITS, maxTotalBytes: 1000 }, { alreadyQueuedTotalBytes: 900 });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("BATCH_TOTAL_SIZE_EXCEEDED");
  });
});

describe("validateIntake — duplicate filename handling within one selection", () => {
  it("accepts the first of two identically-named, identically-sized files and rejects the second", () => {
    const files = [makeFile("a.stl", 100), makeFile("a.stl", 100)];
    const result = validateIntake(files, ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("BATCH_DUPLICATE_FILE");
  });

  it("allows two same-named files of DIFFERENT sizes (genuinely different files)", () => {
    const files = [makeFile("a.stl", 100), makeFile("a.stl", 200)];
    const result = validateIntake(files, ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(result.accepted).toHaveLength(2);
  });
});

describe("validateIntake — deterministic ordering", () => {
  it("preserves the original file order in both accepted and rejected lists", () => {
    const files = [makeFile("a.stl", 10), makeFile("b.obj", 10), makeFile("c.stl", 10)];
    const result = validateIntake(files, ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(result.accepted.map((f) => f.name)).toEqual(["a.stl", "c.stl"]);
    expect(result.rejected.map((r) => r.file.name)).toEqual(["b.obj"]);
  });
});

describe("validateIntake — never reads file bytes during validation", () => {
  it("never calls arrayBuffer() on any candidate file", () => {
    const file = makeFile("a.stl", 10);
    let read = false;
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => {
      read = true;
      return originalArrayBuffer();
    };
    validateIntake([file], ["stl"], DEFAULT_FILE_INTAKE_LIMITS);
    expect(read).toBe(false);
  });
});
