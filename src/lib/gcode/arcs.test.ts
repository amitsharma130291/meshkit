import { describe, expect, it } from "vitest";
import { tokenizeLine } from "./tokenizer";
import { applyModalCommand, createInitialModalState, type ModalState } from "./modal-state";
import { applyArcMove, DEFAULT_ARC_LIMITS } from "./arcs";
import { CancellationRequested } from "../cancellation";

function modal(state: ModalState, line: string): ModalState {
  return applyModalCommand(state, tokenizeLine(line));
}

function arc(state: ModalState, g: 2 | 3, line: string, limits = DEFAULT_ARC_LIMITS, options?: { isCancelled?: () => boolean }) {
  return applyArcMove(state, g, tokenizeLine(line), limits, options);
}

function dist(p: { a: number; b: number }, q: { a: number; b: number }): number {
  return Math.hypot(p.a - q.a, p.b - q.b);
}

describe("applyArcMove — I/J center-offset form, quarter and semicircle", () => {
  it("resolves a CCW quarter circle (G3) with the expected 90-degree sweep", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X0 Y10 I-10 J0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sweepRadians).toBeCloseTo(Math.PI / 2, 6);
      expect(r.center).toEqual({ a: 0, b: 0 });
    }
  });

  it("resolves a CW quarter circle (G2) with the expected 90-degree sweep", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 2, "G2 X0 Y-10 I-10 J0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeCloseTo(Math.PI / 2, 6);
  });

  it("resolves a semicircle with a 180-degree sweep", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X-10 Y0 I-10 J0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeCloseTo(Math.PI, 6);
  });

  it("resolves a full circle when the endpoint equals the start (I/J form only)", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X10 Y0 I-10 J0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeCloseTo(2 * Math.PI, 6);
  });

  it("rejects an I/J arc whose endpoint is not equidistant from the declared center (a genuinely invalid arc), never silently drawing a straight line", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 0, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X5 Y5 I10 J0");
    expect(r.ok).toBe(false);
    expect(r.segments.length).toBe(0);
  });
});

describe("applyArcMove — all three planes", () => {
  it("resolves an XZ-plane arc (G18) using I/K", () => {
    let state = modal(createInitialModalState(), "G18");
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X0 Z10 I-10 K0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeCloseTo(Math.PI / 2, 6);
  });

  it("resolves a YZ-plane arc (G19) using J/K", () => {
    let state = modal(createInitialModalState(), "G19");
    state = { ...state, position: { x: 0, y: 10, z: 0 } };
    const r = arc(state, 3, "G3 Y0 Z10 J-10 K0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("applyArcMove — R (radius) form", () => {
  it("a positive R takes the short way (sweep <= 180 degrees)", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 0, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X10 Y0 R13");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it("a negative R takes the long way (sweep > 180 degrees)", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 0, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X10 Y0 R-13");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sweepRadians).toBeGreaterThan(Math.PI);
  });

  it("the resolved center is equidistant (|R|) from both start and end", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 0, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X10 Y0 R13");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(dist(r.center, { a: 0, b: 0 })).toBeCloseTo(13, 5);
      expect(dist(r.center, { a: 10, b: 0 })).toBeCloseTo(13, 5);
    }
  });

  it("rejects an impossible radius (chord longer than the diameter)", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 0, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X100 Y0 R1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("impossible-radius");
  });

  it("rejects an R-form arc whose endpoint equals its start (center is undetermined from a zero-length chord)", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 5, y: 5, z: 0 } };
    const r = arc(state, 3, "G3 X5 Y5 R10");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-center");
  });
});

describe("applyArcMove — helical interpolation and E", () => {
  it("interpolates the perpendicular (Z) axis linearly across a helical arc", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X-10 Y0 Z2 I-10 J0");
    expect(r.ok).toBe(true);
    expect(r.eEnd).toBe(0);
    if (r.ok && r.segments.length > 0) {
      expect(r.segments[r.segments.length - 1].end.z).toBeCloseTo(2, 6);
      expect(r.segments[0].start.z).toBeCloseTo(0, 6);
      // Z should be monotonically increasing across a simple helix.
      for (let i = 1; i < r.segments.length; i++) {
        expect(r.segments[i].start.z).toBeGreaterThanOrEqual(r.segments[i - 1].start.z - 1e-9);
      }
    }
  });

  it("interpolates E linearly across the arc's segments and reports the total delta", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X-10 Y0 I-10 J0 E5");
    expect(r.ok).toBe(true);
    expect(r.eStart).toBe(0);
    expect(r.eEnd).toBe(5);
    expect(r.eDelta).toBe(5);
    if (r.ok) {
      expect(r.segments[0].eStart).toBe(0);
      expect(r.segments[r.segments.length - 1].eEnd).toBeCloseTo(5, 6);
      for (let i = 1; i < r.segments.length; i++) {
        expect(r.segments[i].eStart).toBeCloseTo(r.segments[i - 1].eEnd, 9);
      }
    }
  });

  it("carries feed rate from modal state, reusing whatever was last commanded", () => {
    let state = modal(createInitialModalState(), "F2400");
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X-10 Y0 I-10 J0");
    expect(r.feedRate).toBe(2400);
  });
});

describe("applyArcMove — inch mode", () => {
  it("converts I/J and endpoint coordinates from inches to millimeters", () => {
    let state = modal(createInitialModalState(), "G20");
    // position is always stored in mm internally — 1 inch = 25.4mm.
    state = { ...state, position: { x: 25.4, y: 0, z: 0 } };
    const r = arc(state, 3, "G3 X-1 Y0 I-1 J0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.center).toEqual({ a: 0, b: 0 });
      // 1 inch radius arc should resolve to a 25.4mm radius circle.
      expect(r.radius).toBeCloseTo(25.4, 5);
    }
  });
});

describe("applyArcMove — subdivision ceiling", () => {
  it("clamps segment count to the configured ceiling and flags it, without failing the arc", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const tightLimits = { ...DEFAULT_ARC_LIMITS, maxSegmentsPerArc: 4 };
    const r = arc(state, 3, "G3 X10 Y0 I-10 J0", tightLimits); // full circle, would normally need many segments
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.segments.length).toBeLessThanOrEqual(4);
      expect(r.subdivisionCeilingHit).toBe(true);
    }
  });
});

describe("applyArcMove — active nozzle temperature propagation", () => {
  it("carries the active tool's target temperature in effect at the time of the arc, null when unknown", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    expect(arc(state, 3, "G3 X-10 Y0 I-10 J0").temperature).toBeNull();
    const heated = modal(state, "M104 S210");
    expect(arc(heated, 3, "G3 X-10 Y0 I-10 J0").temperature).toBe(210);
  });
});

describe("applyArcMove — cancellation", () => {
  it("throws CancellationRequested when the caller signals cancellation mid-generation", () => {
    let state = createInitialModalState();
    state = { ...state, position: { x: 10, y: 0, z: 0 } };
    const bigLimits = { ...DEFAULT_ARC_LIMITS, maxSegmentsPerArc: 10_000, maxChordError: 0.0001 };
    expect(() => arc(state, 3, "G3 X10 Y0 I-10 J0", bigLimits, { isCancelled: () => true })).toThrow(CancellationRequested);
  });
});
