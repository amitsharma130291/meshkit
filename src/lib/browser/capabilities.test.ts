import { describe, expect, it } from "vitest";
import { normalizeCapabilities, type RawCapabilityFlags } from "./capabilities";

const allSupported: RawCapabilityFlags = {
  webAssembly: true,
  webWorkers: true,
  moduleWorkers: true,
  webglAny: true,
  webgl2: true,
  fileApi: true,
  blobUrls: true,
  transferableArrayBuffer: true,
  offscreenCanvas: true,
  sharedArrayBuffer: true,
};

describe("normalizeCapabilities", () => {
  it("reports ready with no missing capabilities when everything is supported", () => {
    const report = normalizeCapabilities(allSupported);
    expect(report.ready).toBe(true);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional).toEqual([]);
  });

  it("is not ready when a required capability is missing, and surfaces a recovery message", () => {
    const report = normalizeCapabilities({ ...allSupported, webAssembly: false });
    expect(report.ready).toBe(false);
    expect(report.missingRequired).toEqual(["webAssembly"]);
    expect(report.recoveryMessages).toHaveLength(1);
  });

  it("treats a missing optional capability as non-blocking", () => {
    const report = normalizeCapabilities({ ...allSupported, offscreenCanvas: false, sharedArrayBuffer: false });
    expect(report.ready).toBe(true);
    expect(report.missingOptional).toEqual(["offscreenCanvas", "sharedArrayBuffer"]);
  });
});
