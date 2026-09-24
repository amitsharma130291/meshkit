import { describe, expect, it } from "vitest";
import { inferDialect } from "./dialect";
import type { SlicerCommentSignal } from "./comments";

function signal(overrides: Partial<SlicerCommentSignal> = {}): SlicerCommentSignal {
  return {
    slicerHint: null,
    layerMarker: false,
    layerIndex: null,
    layerZ: null,
    layerHeight: null,
    featureLabel: null,
    estimatedPrintTimeSeconds: null,
    filamentUsedMm: null,
    layerCount: null,
    bounds: null,
    ...overrides,
  };
}

describe("inferDialect", () => {
  it("reports 'unknown' with low confidence when no signal ever named a slicer", () => {
    const result = inferDialect([signal(), signal({ layerMarker: true })]);
    expect(result.slicer).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("reports the named slicer with high confidence when an explicit generator header was seen", () => {
    const result = inferDialect([signal(), signal({ slicerHint: "prusaslicer" }), signal()]);
    expect(result.slicer).toBe("prusaslicer");
    expect(result.confidence).toBe("high");
  });

  it("picks the most frequently named slicer if more than one hint somehow appears", () => {
    const result = inferDialect([signal({ slicerHint: "cura" }), signal({ slicerHint: "prusaslicer" }), signal({ slicerHint: "prusaslicer" })]);
    expect(result.slicer).toBe("prusaslicer");
  });

  it("is deterministic for an empty signal list", () => {
    expect(inferDialect([])).toEqual({ slicer: "unknown", confidence: "low" });
  });
});
