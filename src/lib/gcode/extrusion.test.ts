import { describe, expect, it } from "vitest";
import { classifyExtrusionEvents } from "./extrusion";
import type { LinearMove } from "./linear-moves";

function moveStub(eDelta: number, volumetric = false): LinearMove {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 1, y: 0, z: 0 },
    eStart: 0,
    eEnd: eDelta,
    eDelta,
    feedRate: null,
    category: eDelta > 0 ? "extrusion" : eDelta < 0 ? "retract" : "travel",
    rapid: false,
    tool: 0,
    volumetric,
    temperature: null,
  };
}

describe("classifyExtrusionEvents", () => {
  it("classifies a positive delta with no prior retraction as plain extrusion", () => {
    const events = classifyExtrusionEvents([moveStub(1)]);
    expect(events[0].kind).toBe("extrusion");
  });

  it("classifies a negative delta as retraction", () => {
    const events = classifyExtrusionEvents([moveStub(-1)]);
    expect(events[0].kind).toBe("retraction");
  });

  it("classifies a zero delta as none", () => {
    const events = classifyExtrusionEvents([moveStub(0)]);
    expect(events[0].kind).toBe("none");
  });

  it("classifies the FIRST positive delta immediately after one or more retractions as prime", () => {
    const events = classifyExtrusionEvents([moveStub(-1), moveStub(-0.5), moveStub(1.5)]);
    expect(events[2].kind).toBe("prime");
  });

  it("classifies a SECOND positive delta after priming as plain extrusion again, not prime", () => {
    const events = classifyExtrusionEvents([moveStub(-1), moveStub(1), moveStub(0.8)]);
    expect(events[1].kind).toBe("prime");
    expect(events[2].kind).toBe("extrusion");
  });

  it("a zero-delta move between retraction and the next extrusion doesn't cancel the pending prime", () => {
    const events = classifyExtrusionEvents([moveStub(-1), moveStub(0), moveStub(1)]);
    expect(events[2].kind).toBe("prime");
  });

  it("reports lengthMm equal to the raw delta for non-volumetric moves", () => {
    const events = classifyExtrusionEvents([moveStub(2.5, false)]);
    expect(events[0].lengthMm).toBe(2.5);
  });

  it("never reports a millimeter length for a volumetric move", () => {
    const events = classifyExtrusionEvents([moveStub(2.5, true)]);
    expect(events[0].lengthMm).toBeNull();
    expect(events[0].rawDelta).toBe(2.5);
    expect(events[0].volumetric).toBe(true);
  });
});
