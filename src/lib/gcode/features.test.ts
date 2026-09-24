import { describe, expect, it } from "vitest";
import { classifyFeatureLabel } from "./features";

describe("classifyFeatureLabel — travel always wins regardless of label", () => {
  it("classifies any travel move as 'travel', even with a stray feature label", () => {
    expect(classifyFeatureLabel("WALL-OUTER", "travel")).toBe("travel");
  });
});

describe("classifyFeatureLabel — no label at all on an extruding move", () => {
  it("classifies as 'unknown-extrusion' when there is no feature label", () => {
    expect(classifyFeatureLabel(null, "extrusion")).toBe("unknown-extrusion");
  });
});

describe("classifyFeatureLabel — walls", () => {
  it("recognizes Cura's WALL-OUTER / WALL-INNER", () => {
    expect(classifyFeatureLabel("WALL-OUTER", "extrusion")).toBe("outer-wall");
    expect(classifyFeatureLabel("WALL-INNER", "extrusion")).toBe("inner-wall");
  });

  it("recognizes PrusaSlicer/Orca's 'External perimeter' vs. plain 'Perimeter'", () => {
    expect(classifyFeatureLabel("External perimeter", "extrusion")).toBe("outer-wall");
    expect(classifyFeatureLabel("Perimeter", "extrusion")).toBe("inner-wall");
  });

  it("recognizes Bambu/Orca's 'Outer wall' / 'Inner wall'", () => {
    expect(classifyFeatureLabel("Outer wall", "extrusion")).toBe("outer-wall");
    expect(classifyFeatureLabel("Inner wall", "extrusion")).toBe("inner-wall");
  });
});

describe("classifyFeatureLabel — infill", () => {
  it("recognizes generic infill labels", () => {
    expect(classifyFeatureLabel("FILL", "extrusion")).toBe("infill");
    expect(classifyFeatureLabel("Internal infill", "extrusion")).toBe("infill");
    expect(classifyFeatureLabel("Sparse infill", "extrusion")).toBe("infill");
  });

  it("recognizes solid infill distinctly from generic infill", () => {
    expect(classifyFeatureLabel("Solid infill", "extrusion")).toBe("solid-infill");
  });

  it("recognizes top/bottom solid infill as top/bottom surface, not generic solid infill", () => {
    expect(classifyFeatureLabel("Top solid infill", "extrusion")).toBe("top-surface");
    expect(classifyFeatureLabel("Bottom solid infill", "extrusion")).toBe("bottom-surface");
    expect(classifyFeatureLabel("SKIN", "extrusion")).not.toBe("unknown-extrusion");
  });
});

describe("classifyFeatureLabel — support, bridge, and auxiliary structures", () => {
  it("recognizes support and support-interface distinctly", () => {
    expect(classifyFeatureLabel("SUPPORT", "extrusion")).toBe("support");
    expect(classifyFeatureLabel("Support material", "extrusion")).toBe("support");
    expect(classifyFeatureLabel("SUPPORT-INTERFACE", "extrusion")).toBe("support-interface");
    expect(classifyFeatureLabel("Support material interface", "extrusion")).toBe("support-interface");
  });

  it("recognizes bridge infill", () => {
    expect(classifyFeatureLabel("Bridge infill", "extrusion")).toBe("bridge");
  });

  it("recognizes skirt, brim, raft", () => {
    expect(classifyFeatureLabel("SKIRT", "extrusion")).toBe("skirt");
    expect(classifyFeatureLabel("Brim", "extrusion")).toBe("brim");
    expect(classifyFeatureLabel("Raft", "extrusion")).toBe("raft");
  });

  it("recognizes prime tower and purge", () => {
    expect(classifyFeatureLabel("PRIME-TOWER", "extrusion")).toBe("prime-tower");
    expect(classifyFeatureLabel("Prime tower", "extrusion")).toBe("prime-tower");
    expect(classifyFeatureLabel("Purge", "extrusion")).toBe("purge");
  });
});

describe("classifyFeatureLabel — unrecognized-but-present labels are 'custom', not 'unknown-extrusion'", () => {
  it("distinguishes 'no label at all' from 'a real label we don't specifically map'", () => {
    expect(classifyFeatureLabel(null, "extrusion")).toBe("unknown-extrusion");
    expect(classifyFeatureLabel("Some future slicer feature", "extrusion")).toBe("custom");
  });
});

describe("classifyFeatureLabel — never affects motion coordinates (pure function, string in, category out)", () => {
  it("is a pure function of its two inputs", () => {
    expect(classifyFeatureLabel("WALL-OUTER", "extrusion")).toBe(classifyFeatureLabel("WALL-OUTER", "extrusion"));
  });
});
