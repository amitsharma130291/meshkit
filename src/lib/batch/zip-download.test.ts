import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildBatchZip, DEFAULT_ZIP_DOWNLOAD_LIMITS, type ZipJobEntry } from "./zip-download";

function entry(overrides: Partial<ZipJobEntry> = {}): ZipJobEntry {
  return {
    jobId: "job-1",
    outputFilename: "part.stl",
    outputBytes: new TextEncoder().encode("solid x endsolid x").buffer as ArrayBuffer,
    reportJson: JSON.stringify({ jobId: "job-1", outcome: "ok" }),
    state: "succeeded",
    ...overrides,
  };
}

describe("buildBatchZip — contents and structure", () => {
  it("writes succeeded outputs under outputs/, a report per file under reports/, and a top-level batch-summary.json", () => {
    const zipBytes = buildBatchZip([entry()], JSON.stringify({ total: 1 }));
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files).sort()).toEqual(["batch-summary.json", "outputs/part.stl", "reports/part.stl.json"]);
    expect(strFromU8(files["batch-summary.json"])).toContain('"total":1');
  });

  it("includes a failed job's report but never a fake output file for it", () => {
    const failed = entry({ jobId: "job-2", outputFilename: "broken.stl", outputBytes: null, state: "failed", reportJson: JSON.stringify({ jobId: "job-2" }) });
    const zipBytes = buildBatchZip([entry(), failed], JSON.stringify({ total: 2 }));
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(files["outputs/broken.stl"]).toBeUndefined();
    expect(files["reports/broken.stl.json"]).toBeDefined();
  });

  it("includes a cancelled job's report but never a fake output file for it", () => {
    const cancelled = entry({ jobId: "job-3", outputFilename: "cancelled.stl", outputBytes: null, state: "cancelled" });
    const zipBytes = buildBatchZip([cancelled], JSON.stringify({ total: 1 }));
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(files["outputs/cancelled.stl"]).toBeUndefined();
    expect(files["reports/cancelled.stl.json"]).toBeDefined();
  });

  it("correctly round-trips output bytes", () => {
    const original = new TextEncoder().encode("solid part endsolid part");
    const zipBytes = buildBatchZip([entry({ outputBytes: original.buffer as ArrayBuffer })], "{}");
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(files["outputs/part.stl"]).toEqual(original);
  });

  it("resolves a collision between two output filenames defensively, even if the caller didn't", () => {
    const a = entry({ jobId: "a", outputFilename: "part.stl" });
    const b = entry({ jobId: "b", outputFilename: "part.stl" });
    const zipBytes = buildBatchZip([a, b], "{}");
    const files = unzipSync(new Uint8Array(zipBytes));
    const outputPaths = Object.keys(files).filter((k) => k.startsWith("outputs/"));
    expect(outputPaths).toHaveLength(2);
    expect(new Set(outputPaths).size).toBe(2);
  });

  it("handles Unicode filenames correctly", () => {
    const zipBytes = buildBatchZip([entry({ outputFilename: "零件.stl" })], "{}");
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(files["outputs/零件.stl"]).toBeDefined();
  });
});

describe("buildBatchZip — ceilings", () => {
  it("refuses when the file count ceiling is exceeded", () => {
    const entries = Array.from({ length: 3 }, (_, i) => entry({ jobId: `job-${i}`, outputFilename: `part-${i}.stl` }));
    expect(() => buildBatchZip(entries, "{}", { ...DEFAULT_ZIP_DOWNLOAD_LIMITS, maxFileCount: 2 })).toThrow();
  });

  it("refuses when total uncompressed bytes exceed the ceiling", () => {
    const big = entry({ outputBytes: new ArrayBuffer(1000) });
    expect(() => buildBatchZip([big], "{}", { ...DEFAULT_ZIP_DOWNLOAD_LIMITS, maxUncompressedBytes: 100 })).toThrow();
  });

  it("refuses a single output larger than the individual-file ceiling", () => {
    const big = entry({ outputBytes: new ArrayBuffer(1000) });
    expect(() => buildBatchZip([big], "{}", { ...DEFAULT_ZIP_DOWNLOAD_LIMITS, maxIndividualOutputBytes: 100 })).toThrow();
  });

  it("refuses a filename longer than the ceiling", () => {
    const long = entry({ outputFilename: "x".repeat(300) + ".stl" });
    expect(() => buildBatchZip([long], "{}", { ...DEFAULT_ZIP_DOWNLOAD_LIMITS, maxFilenameLength: 50 })).toThrow();
  });

  it("refuses a generated summary report larger than the ceiling", () => {
    const hugeSummary = JSON.stringify({ data: "x".repeat(1000) });
    expect(() => buildBatchZip([entry()], hugeSummary, { ...DEFAULT_ZIP_DOWNLOAD_LIMITS, maxReportBytes: 100 })).toThrow();
  });

  it("never throws for a batch comfortably within every default ceiling", () => {
    expect(() => buildBatchZip([entry()], "{}")).not.toThrow();
  });
});
