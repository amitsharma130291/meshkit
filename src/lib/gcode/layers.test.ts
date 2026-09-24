import { describe, expect, it } from "vitest";
import { detectLayers, type LayerLineEvent } from "./layers";
import type { SlicerCommentSignal } from "./comments";

function emptySignal(overrides: Partial<SlicerCommentSignal> = {}): SlicerCommentSignal {
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

function markerEvent(lineIndex: number, layerIndex: number | null): LayerLineEvent {
  return { lineIndex, commentSignal: emptySignal({ layerMarker: true, layerIndex }), moveZ: null, moveCategory: null };
}

function zEvent(lineIndex: number, z: number): LayerLineEvent {
  return { lineIndex, commentSignal: emptySignal({ layerZ: z }), moveZ: null, moveCategory: null };
}

function moveEvent(lineIndex: number, z: number, category: LayerLineEvent["moveCategory"]): LayerLineEvent {
  return { lineIndex, commentSignal: null, moveZ: z, moveCategory: category };
}

describe("detectLayers — explicit markers (Cura-style ;LAYER:n)", () => {
  it("uses explicit LAYER markers and reports mode 'explicit'", () => {
    const events = [markerEvent(0, 0), moveEvent(1, 0.2, "extrusion"), markerEvent(2, 1), moveEvent(3, 0.4, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit");
    expect(result.layers.length).toBe(2);
    expect(result.layers[0].index).toBe(0);
    expect(result.layers[1].index).toBe(1);
    expect(result.layers[0].source).toBe("explicit");
  });
});

describe("detectLayers — explicit markers (PrusaSlicer/Orca-style LAYER_CHANGE + Z:/HEIGHT:)", () => {
  it("associates a following Z:/HEIGHT: comment with the just-opened layer", () => {
    const events = [markerEvent(0, null), zEvent(1, 0.2), { lineIndex: 2, commentSignal: emptySignal({ layerHeight: 0.2 }), moveZ: null, moveCategory: null }, moveEvent(3, 0.2, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit");
    expect(result.layers[0].z).toBe(0.2);
    expect(result.layers[0].height).toBe(0.2);
  });

  it("assigns sequential indices when the marker itself carries no explicit index", () => {
    const events = [markerEvent(0, null), markerEvent(1, null), markerEvent(2, null)];
    const result = detectLayers(events);
    expect(result.layers.map((l) => l.index)).toEqual([0, 1, 2]);
  });
});

describe("detectLayers — Bambu/Orca-style CHANGE_LAYER markers", () => {
  it("treats any layerMarker signal the same way regardless of which slicer produced it", () => {
    const events = [markerEvent(0, null), moveEvent(1, 0.2, "extrusion"), markerEvent(2, null), moveEvent(3, 0.4, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit");
    expect(result.layers.length).toBe(2);
  });
});

describe("detectLayers — inference (no comments at all)", () => {
  it("infers discrete layers purely from extrusion Z jumps", () => {
    const events = [
      moveEvent(0, 0.2, "extrusion"),
      moveEvent(1, 0.2, "extrusion"),
      moveEvent(2, 0.4, "extrusion"),
      moveEvent(3, 0.4, "extrusion"),
      moveEvent(4, 0.6, "extrusion"),
    ];
    const result = detectLayers(events);
    expect(result.mode).toBe("inferred");
    expect(result.layers.map((l) => l.z)).toEqual([0.2, 0.4, 0.6]);
  });

  it("reports height as the Z delta from the previous inferred layer", () => {
    const events = [moveEvent(0, 0.2, "extrusion"), moveEvent(1, 0.5, "extrusion")];
    const result = detectLayers(events);
    expect(result.layers[0].height).toBeNull(); // no previous layer to diff against
    expect(result.layers[1].height).toBeCloseTo(0.3, 6);
  });
});

describe("detectLayers — Z-hop never creates a false layer", () => {
  it("ignores a travel/z-only Z change entirely when inferring layers", () => {
    const events = [
      moveEvent(0, 0.2, "extrusion"),
      moveEvent(1, 0.7, "z-only"), // a Z-hop up
      moveEvent(2, 0.2, "z-only"), // back down
      moveEvent(3, 0.2, "extrusion"), // still the same physical layer
    ];
    const result = detectLayers(events);
    expect(result.layers.length).toBe(1);
    expect(result.layers[0].z).toBe(0.2);
  });
});

describe("detectLayers — floating-point Z noise tolerance", () => {
  it("does not start a new layer for a sub-tolerance Z difference", () => {
    const events = [moveEvent(0, 0.2, "extrusion"), moveEvent(1, 0.2000000001, "extrusion")];
    const result = detectLayers(events);
    expect(result.layers.length).toBe(1);
  });
});

describe("detectLayers — variable layer heights", () => {
  it("detects each layer correctly even when the Z delta between layers varies", () => {
    const events = [moveEvent(0, 0.2, "extrusion"), moveEvent(1, 0.5, "extrusion"), moveEvent(2, 0.65, "extrusion")];
    const result = detectLayers(events);
    expect(result.layers.map((l) => l.z)).toEqual([0.2, 0.5, 0.65]);
    expect(result.layers[1].height).toBeCloseTo(0.3, 6);
    expect(result.layers[2].height).toBeCloseTo(0.15, 6);
  });
});

describe("detectLayers — repeated and decreasing Z", () => {
  it("a repeated exact Z among extrusion moves stays in the same layer", () => {
    const events = [moveEvent(0, 0.2, "extrusion"), moveEvent(1, 0.2, "extrusion"), moveEvent(2, 0.2, "extrusion")];
    expect(detectLayers(events).layers.length).toBe(1);
  });

  it("a decreasing Z among extrusion moves never spuriously starts a new layer", () => {
    const events = [moveEvent(0, 0.4, "extrusion"), moveEvent(1, 0.2, "extrusion")];
    const result = detectLayers(events);
    expect(result.layers.length).toBe(1);
  });
});

describe("detectLayers — spiral/vase motion (continuously varying Z)", () => {
  it("recognizes near-continuous Z change as non-planar and does not claim conventional discrete layers", () => {
    const events: LayerLineEvent[] = [];
    for (let i = 0; i < 50; i++) events.push(moveEvent(i, 0.2 + i * 0.002, "extrusion"));
    const result = detectLayers(events);
    expect(result.nonPlanarDetected).toBe(true);
    expect(result.mode).toBe("unknown");
    expect(result.note).toBeTruthy();
  });
});

describe("detectLayers — mixed: explicit markers followed by unmarked (inferred) layers", () => {
  it("returns mode 'mixed' when trailing unmarked extrusion adds genuinely new layers after the last explicit marker", () => {
    const events = [
      markerEvent(0, 0),
      moveEvent(1, 0.2, "extrusion"),
      markerEvent(2, 1),
      moveEvent(3, 0.4, "extrusion"),
      // no marker for the next layer — must be inferred
      moveEvent(4, 0.6, "extrusion"),
    ];
    const result = detectLayers(events);
    expect(result.mode).toBe("mixed");
    expect(result.layers.length).toBe(3);
    expect(result.layers[0].source).toBe("explicit");
    expect(result.layers[1].source).toBe("explicit");
    expect(result.layers[2].source).toBe("inferred");
    expect(result.layers[2].z).toBe(0.6);
    // sequential renumbering — never colliding with an explicit marker's own declared index
    expect(result.layers.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it("does not report 'mixed' when nothing follows the last marker (still fully explicit)", () => {
    const events = [markerEvent(0, 0), moveEvent(1, 0.2, "extrusion"), markerEvent(2, 1), moveEvent(3, 0.4, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit");
    expect(result.layers.length).toBe(2);
  });
});

describe("detectLayers — mixed: inferred initial layer followed by explicit markers", () => {
  it("infers a leading layer from unmarked extrusion before the first marker, then continues with explicit layers", () => {
    const events = [
      moveEvent(0, 0.2, "extrusion"), // no marker yet — must be inferred as layer 0
      markerEvent(1, null),
      moveEvent(2, 0.4, "extrusion"),
      markerEvent(3, null),
      moveEvent(4, 0.6, "extrusion"),
    ];
    const result = detectLayers(events);
    expect(result.mode).toBe("mixed");
    expect(result.layers.length).toBe(3);
    expect(result.layers[0].source).toBe("inferred");
    expect(result.layers[0].z).toBe(0.2);
    expect(result.layers[1].source).toBe("explicit");
    expect(result.layers[2].source).toBe("explicit");
    expect(result.layers.map((l) => l.index)).toEqual([0, 1, 2]);
  });
});

describe("detectLayers — mixed: Z-hop between explicit and inferred sections never creates a false layer", () => {
  it("ignores a Z-hop in the trailing inferred region", () => {
    const events = [
      markerEvent(0, 0),
      moveEvent(1, 0.2, "extrusion"),
      moveEvent(2, 0.7, "z-only"), // Z-hop up
      moveEvent(3, 0.2, "z-only"), // back down
      moveEvent(4, 0.2, "extrusion"), // still the same physical layer
    ];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit"); // no genuinely new layer was ever added
    expect(result.layers.length).toBe(1);
  });
});

describe("detectLayers — mixed: continuity at the explicit/inferred boundary", () => {
  it("does not create a duplicate layer when the first trailing inferred Z matches the last explicit layer's own Z", () => {
    const events = [markerEvent(0, 0), zEvent(1, 0.2), moveEvent(2, 0.2, "extrusion"), moveEvent(3, 0.2, "extrusion")];
    const result = detectLayers(events);
    // the trailing extrusion at the SAME Z as the last explicit layer must not spuriously start a new layer.
    expect(result.mode).toBe("explicit");
    expect(result.layers.length).toBe(1);
  });

  it("does add a genuinely new trailing layer once Z actually increases past the last explicit layer's own Z", () => {
    const events = [markerEvent(0, 0), zEvent(1, 0.2), moveEvent(2, 0.2, "extrusion"), moveEvent(3, 0.4, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("mixed");
    expect(result.layers.length).toBe(2);
    expect(result.layers[1].z).toBe(0.4);
  });
});

describe("detectLayers — mixed: non-planar trailing motion is excluded, never faked as discrete layers", () => {
  it("keeps the explicit layers but never adds spurious inferred layers when the trailing region is non-planar", () => {
    const events: LayerLineEvent[] = [markerEvent(0, 0), moveEvent(1, 0.2, "extrusion")];
    for (let i = 0; i < 20; i++) events.push(moveEvent(i + 2, 0.2 + i * 0.002, "extrusion"));
    const result = detectLayers(events);
    expect(result.layers.length).toBe(1);
    expect(result.layers[0].source).toBe("explicit");
    expect(result.mode).toBe("explicit");
    expect(result.note).toBeTruthy();
  });
});

describe("detectLayers — conflicting explicit layer number and extrusion Z", () => {
  it("trusts the explicit marker's own declared index even when it doesn't match monotonic Z order — explicit always wins, never silently corrected", () => {
    const events = [markerEvent(0, 5), zEvent(1, 0.2), moveEvent(2, 0.2, "extrusion"), markerEvent(3, 2), zEvent(4, 0.1), moveEvent(5, 0.1, "extrusion")];
    const result = detectLayers(events);
    expect(result.mode).toBe("explicit");
    expect(result.layers.map((l) => l.index)).toEqual([5, 2]);
  });
});

describe("detectLayers — no comments and no extrusion at all", () => {
  it("returns an empty layer list with mode 'unknown' rather than inventing one", () => {
    const events = [moveEvent(0, 0, "travel")];
    const result = detectLayers(events);
    expect(result.layers).toEqual([]);
    expect(result.mode).toBe("unknown");
  });
});
