import { describe, expect, it } from "vitest";
import { tokenizeLine } from "./tokenizer";
import { applyModalCommand, createInitialModalState } from "./modal-state";

function apply(state: ReturnType<typeof createInitialModalState>, line: string) {
  return applyModalCommand(state, tokenizeLine(line));
}

describe("createInitialModalState — documented defaults", () => {
  it("defaults to millimeters, not explicitly declared", () => {
    const s = createInitialModalState();
    expect(s.unitMode).toBe("mm");
    expect(s.unitsExplicit).toBe(false);
  });

  it("defaults axis positioning to absolute", () => {
    expect(createInitialModalState().axisPositioning).toBe("absolute");
  });

  it("defaults extruder positioning to absolute (M82), independent of axis positioning", () => {
    expect(createInitialModalState().extruderPositioning).toBe("absolute");
  });

  it("defaults workspace plane to XY (G17) and active tool to 0", () => {
    const s = createInitialModalState();
    expect(s.workspacePlane).toBe("XY");
    expect(s.activeTool).toBe(0);
  });
});

describe("units — G20/G21", () => {
  it("G21 selects millimeters and marks units as explicitly declared", () => {
    const s = apply(createInitialModalState(), "G21");
    expect(s.unitMode).toBe("mm");
    expect(s.unitsExplicit).toBe(true);
  });

  it("G20 selects inches and marks units as explicitly declared", () => {
    const s = apply(createInitialModalState(), "G20");
    expect(s.unitMode).toBe("inch");
    expect(s.unitsExplicit).toBe(true);
  });
});

describe("axis positioning — G90/G91", () => {
  it("G90 sets absolute axis positioning", () => {
    const s = apply(apply(createInitialModalState(), "G91"), "G90");
    expect(s.axisPositioning).toBe("absolute");
  });

  it("G91 sets relative axis positioning", () => {
    expect(apply(createInitialModalState(), "G91").axisPositioning).toBe("relative");
  });
});

describe("G90/G91 vs M82/M83 — the documented Marlin-compatible interaction", () => {
  it("M83 sets relative extrusion WITHOUT affecting axis positioning", () => {
    const s = apply(createInitialModalState(), "M83");
    expect(s.extruderPositioning).toBe("relative");
    expect(s.axisPositioning).toBe("absolute");
  });

  it("M82 sets absolute extrusion WITHOUT affecting axis positioning", () => {
    const s = apply(apply(createInitialModalState(), "G91"), "M82");
    expect(s.extruderPositioning).toBe("absolute");
    expect(s.axisPositioning).toBe("relative");
  });

  it("G90/G91 NEVER implicitly change extruder positioning — MeshWrench's documented policy is that E is governed exclusively by M82/M83, matching every supported slicer dialect (Cura/PrusaSlicer/OrcaSlicer/Bambu Studio all emit M82/M83 independently of G90/G91)", () => {
    let s = createInitialModalState();
    s = apply(s, "M83"); // relative extrusion
    s = apply(s, "G91"); // relative axes — must NOT reset E back to absolute
    expect(s.extruderPositioning).toBe("relative");
    expect(s.axisPositioning).toBe("relative");
    s = apply(s, "G90"); // absolute axes — must NOT force E back to absolute either
    expect(s.extruderPositioning).toBe("relative");
    expect(s.axisPositioning).toBe("absolute");
  });
});

describe("workspace plane — G17/G18/G19", () => {
  it("selects XY, XZ, YZ respectively", () => {
    expect(apply(createInitialModalState(), "G18").workspacePlane).toBe("XZ");
    expect(apply(createInitialModalState(), "G19").workspacePlane).toBe("YZ");
    expect(apply(apply(createInitialModalState(), "G18"), "G17").workspacePlane).toBe("XY");
  });
});

describe("tool selection — T0, T1, ...", () => {
  it("switches the active tool and gives each tool its own independent E position starting at 0", () => {
    let s = createInitialModalState();
    s = apply(s, "T1");
    expect(s.activeTool).toBe(1);
    expect(s.toolEPosition[1]).toBe(0);
    expect(s.toolEPosition[0]).toBe(0);
  });

  it("preserves a previously-used tool's own E position when switching back to it", () => {
    let s = createInitialModalState();
    s = { ...s, toolEPosition: { ...s.toolEPosition, 0: 12.5 } };
    s = apply(s, "T1");
    s = apply(s, "T0");
    expect(s.toolEPosition[0]).toBe(12.5);
  });
});

describe("G92 — position reset without motion", () => {
  it("sets only the specified axes, leaving others untouched", () => {
    let s = createInitialModalState();
    s = { ...s, position: { x: 10, y: 20, z: 5 } };
    s = apply(s, "G92 X0");
    expect(s.position).toEqual({ x: 0, y: 20, z: 5 });
  });

  it("sets E position for the active tool", () => {
    const s = apply(createInitialModalState(), "G92 E0");
    expect(s.toolEPosition[0]).toBe(0);
  });

  it("with no arguments, is a documented no-op (never invents an all-axis reset)", () => {
    let s = createInitialModalState();
    s = { ...s, position: { x: 10, y: 20, z: 5 } };
    s = apply(s, "G92");
    expect(s.position).toEqual({ x: 10, y: 20, z: 5 });
  });

  it("converts a G92 value from inches to millimeters when inch mode is active", () => {
    let s = createInitialModalState();
    s = apply(s, "G20"); // inches
    s = apply(s, "G92 X1");
    expect(s.position.x).toBeCloseTo(25.4, 5);
  });
});

describe("temperatures, fan, speed/flow factors, volumetric mode", () => {
  it("M104/M109 set the active tool's temperature setpoint", () => {
    const s = apply(createInitialModalState(), "M104 S200");
    expect(s.toolTemperatureSetpoints[0]).toBe(200);
  });

  it("M140/M190 set the bed temperature setpoint", () => {
    expect(apply(createInitialModalState(), "M140 S60").bedTemperatureSetpoint).toBe(60);
  });

  it("M106 sets fan speed, defaulting to full speed with no S", () => {
    expect(apply(createInitialModalState(), "M106 S128").fanSpeed).toBe(128);
    expect(apply(createInitialModalState(), "M106").fanSpeed).toBe(255);
  });

  it("M107 turns the fan off", () => {
    const s = apply(apply(createInitialModalState(), "M106 S255"), "M107");
    expect(s.fanSpeed).toBe(0);
  });

  it("M220/M221 set speed and flow factors, defaulting to 100%", () => {
    const s = createInitialModalState();
    expect(s.speedFactor).toBe(100);
    expect(s.flowFactor).toBe(100);
    expect(apply(s, "M220 S150").speedFactor).toBe(150);
    expect(apply(s, "M221 S90").flowFactor).toBe(90);
  });

  it("M200 with a positive D enables volumetric mode; D0 disables it", () => {
    let s = apply(createInitialModalState(), "M200 D1.75");
    expect(s.volumetric).toBe(true);
    s = apply(s, "M200 D0");
    expect(s.volumetric).toBe(false);
  });
});

describe("feed rate tracking", () => {
  it("a bare F line updates the modal feed rate", () => {
    expect(apply(createInitialModalState(), "F1500").feedRate).toBe(1500);
  });

  it("converts feed rate from inches/min to mm/min when inch mode is active", () => {
    let s = apply(createInitialModalState(), "G20");
    s = apply(s, "F10");
    expect(s.feedRate).toBeCloseTo(254, 5);
  });

  it("feed rate persists across lines that don't mention F", () => {
    let s = apply(createInitialModalState(), "F1200");
    s = apply(s, "G90");
    expect(s.feedRate).toBe(1200);
  });
});

describe("immutability", () => {
  it("never mutates the input state object", () => {
    const s = createInitialModalState();
    const snapshot = JSON.parse(JSON.stringify(s));
    apply(s, "G91");
    expect(s).toEqual(snapshot);
  });
});
