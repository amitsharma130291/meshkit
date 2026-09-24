import { describe, expect, it } from "vitest";
import { tokenizeLine } from "./tokenizer";
import { applyModalCommand, createInitialModalState, type ModalState } from "./modal-state";
import { applyLinearMove } from "./linear-moves";

function modal(state: ModalState, line: string): ModalState {
  return applyModalCommand(state, tokenizeLine(line));
}

function move(state: ModalState, g: 0 | 1, line: string) {
  return applyLinearMove(state, g, tokenizeLine(line));
}

describe("applyLinearMove — absolute XYZ", () => {
  it("moves to the exact commanded absolute position", () => {
    const r = move(createInitialModalState(), 1, "G1 X10 Y20 Z5");
    expect(r.move.end).toEqual({ x: 10, y: 20, z: 5 });
    expect(r.state.position).toEqual({ x: 10, y: 20, z: 5 });
  });

  it("a second absolute move starts from the first move's end position", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10 Y10").state;
    const r = move(state, 1, "G1 X20 Y10");
    expect(r.move.start).toEqual({ x: 10, y: 10, z: 0 });
    expect(r.move.end).toEqual({ x: 20, y: 10, z: 0 });
  });
});

describe("applyLinearMove — relative XYZ", () => {
  it("moves by the commanded delta from the current position", () => {
    let state = modal(createInitialModalState(), "G91");
    state = move(state, 1, "G1 X10 Y10").state;
    const r = move(state, 1, "G1 X5 Y-3");
    expect(r.move.end).toEqual({ x: 15, y: 7, z: 0 });
  });
});

describe("applyLinearMove — absolute and relative E", () => {
  it("absolute E sets the tool's E position exactly", () => {
    const r = move(createInitialModalState(), 1, "G1 X10 E5");
    expect(r.move.eEnd).toBe(5);
    expect(r.move.eDelta).toBe(5);
  });

  it("relative E (M83) accumulates from the current E position", () => {
    let state = modal(createInitialModalState(), "M83");
    state = move(state, 1, "G1 X10 E2").state;
    const r = move(state, 1, "G1 X20 E1.5");
    expect(r.move.eStart).toBe(2);
    expect(r.move.eEnd).toBe(3.5);
    expect(r.move.eDelta).toBeCloseTo(1.5, 10);
  });
});

describe("applyLinearMove — mixed XYZ (absolute) and E (relative) modes", () => {
  it("resolves XYZ absolutely and E relatively on the same line, independently", () => {
    let state = modal(createInitialModalState(), "M83"); // relative E, axes stay absolute
    state = move(state, 1, "G1 X10 E1").state;
    const r = move(state, 1, "G1 X20 E1");
    expect(r.move.end.x).toBe(20); // absolute
    expect(r.move.eDelta).toBe(1); // relative accumulation
    expect(r.move.eEnd).toBe(2);
  });
});

describe("applyLinearMove — G92 interaction", () => {
  it("a move after G92 resolves from the redefined position, never the original", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10").state;
    state = modal(state, "G92 X0");
    const r = move(state, 1, "G1 X5");
    expect(r.move.start.x).toBe(0);
    expect(r.move.end.x).toBe(5);
  });
});

describe("applyLinearMove — feed rate", () => {
  it("a feed-only line (no axes) updates state.feedRate and produces a zero-length-state-update move", () => {
    const r = move(createInitialModalState(), 1, "G1 F3000");
    expect(r.state.feedRate).toBe(3000);
    expect(r.move.category).toBe("zero-length-state-update");
  });

  it("feed rate carries forward onto later moves that don't repeat F", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10 F1500").state;
    const r = move(state, 1, "G1 X20");
    expect(r.move.feedRate).toBe(1500);
  });
});

describe("applyLinearMove — negative coordinates", () => {
  it("supports negative absolute coordinates", () => {
    const r = move(createInitialModalState(), 1, "G1 X-10 Y-5");
    expect(r.move.end).toEqual({ x: -10, y: -5, z: 0 });
  });
});

describe("applyLinearMove — multi-tool E state", () => {
  it("each tool tracks its own E position independently across a tool change", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10 E5").state; // tool 0: E=5
    state = modal(state, "T1");
    state = move(state, 1, "G1 X10 E2").state; // tool 1: E=2
    state = modal(state, "T0");
    const r = move(state, 1, "G1 X10 E7");
    expect(r.move.eStart).toBe(5); // tool 0's own E, unaffected by tool 1's moves
    expect(r.move.eEnd).toBe(7);
    expect(r.state.toolEPosition[1]).toBe(2); // tool 1 unaffected by tool 0's later move
  });
});

describe("applyLinearMove — inch-to-mm conversion", () => {
  it("converts absolute XYZ coordinates from inches to millimeters exactly once", () => {
    let state = modal(createInitialModalState(), "G20");
    const r = move(state, 1, "G1 X1 Y2");
    expect(r.move.end.x).toBeCloseTo(25.4, 5);
    expect(r.move.end.y).toBeCloseTo(50.8, 5);
  });

  it("converts relative deltas from inches to millimeters", () => {
    let state = modal(createInitialModalState(), "G20");
    state = modal(state, "G91");
    const r = move(state, 1, "G1 X1");
    expect(r.move.end.x).toBeCloseTo(25.4, 5);
  });
});

describe("applyLinearMove — omitted axes", () => {
  it("an omitted axis never moves, regardless of positioning mode", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10 Y20 Z5").state;
    const r = move(state, 1, "G1 X15");
    expect(r.move.end).toEqual({ x: 15, y: 20, z: 5 });
  });
});

describe("applyLinearMove — zero-length moves", () => {
  it("commanding the exact current position with no E change is a zero-length-state-update", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 X10 Y10").state;
    const r = move(state, 1, "G1 X10 Y10");
    expect(r.move.category).toBe("zero-length-state-update");
  });
});

describe("applyLinearMove — event classification", () => {
  it("classifies XY movement with positive E delta as extrusion", () => {
    expect(move(createInitialModalState(), 1, "G1 X10 E1").move.category).toBe("extrusion");
  });

  it("classifies XY movement with zero E delta as travel", () => {
    expect(move(createInitialModalState(), 0, "G0 X10 Y10").move.category).toBe("travel");
  });

  it("classifies XY movement with negative E delta as retract", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 E5").state;
    const r = move(state, 1, "G1 X10 E1");
    expect(r.move.category).toBe("retract");
  });

  it("classifies E-only positive delta (no spatial movement) as e-only-extrusion", () => {
    expect(move(createInitialModalState(), 1, "G1 E5").move.category).toBe("e-only-extrusion");
  });

  it("classifies E-only negative delta (no spatial movement) as e-only-retract", () => {
    let state = createInitialModalState();
    state = move(state, 1, "G1 E5").state;
    const r = move(state, 1, "G1 E1");
    expect(r.move.category).toBe("e-only-retract");
  });

  it("classifies a Z-only move with no E change as z-only", () => {
    expect(move(createInitialModalState(), 1, "G1 Z0.2").move.category).toBe("z-only");
  });

  it("never creates spatial line geometry for an E-only event (start equals end in XYZ)", () => {
    const r = move(createInitialModalState(), 1, "G1 E5");
    expect(r.move.start).toEqual(r.move.end);
  });

  it("carries whether the move was rapid (G0) vs. interpolated (G1)", () => {
    expect(move(createInitialModalState(), 0, "G0 X10").move.rapid).toBe(true);
    expect(move(createInitialModalState(), 1, "G1 X10").move.rapid).toBe(false);
  });

  it("carries the volumetric-extrusion flag in effect at the time of the move", () => {
    expect(move(createInitialModalState(), 1, "G1 X10 E1").move.volumetric).toBe(false);
    const volumetricState = modal(createInitialModalState(), "M200 D1.75");
    expect(move(volumetricState, 1, "G1 X10 E1").move.volumetric).toBe(true);
  });
});

describe("applyLinearMove — active nozzle temperature propagation", () => {
  it("a move before any temperature is known carries temperature null", () => {
    expect(move(createInitialModalState(), 1, "G1 X10").move.temperature).toBeNull();
  });

  it("M104 sets the active tool's target temperature, reflected on later moves", () => {
    const state = modal(createInitialModalState(), "M104 S210");
    expect(move(state, 1, "G1 X10").move.temperature).toBe(210);
  });

  it("M109 (set-and-wait) also sets the active tool's target temperature", () => {
    const state = modal(createInitialModalState(), "M109 S215");
    expect(move(state, 1, "G1 X10").move.temperature).toBe(215);
  });

  it("the temperature is retained across later moves that don't mention M104/M109 again", () => {
    let state = modal(createInitialModalState(), "M104 S200");
    state = move(state, 1, "G1 X10").state;
    const r = move(state, 1, "G1 X20");
    expect(r.move.temperature).toBe(200);
  });

  it("each tool tracks its own target temperature independently", () => {
    let state = modal(createInitialModalState(), "M104 S200");
    state = modal(state, "T1");
    state = modal(state, "M104 S230");
    const t1Move = move(state, 1, "G1 X10");
    expect(t1Move.move.temperature).toBe(230);
    const backToT0 = modal(t1Move.state, "T0");
    expect(move(backToT0, 1, "G1 X10").move.temperature).toBe(200);
  });

  it("bed temperature (M140/M190) never appears as the move's own temperature", () => {
    const state = modal(createInitialModalState(), "M140 S60");
    expect(move(state, 1, "G1 X10").move.temperature).toBeNull();
  });

  it("temperature can change again within what would be the same layer (no layer-boundary dependency)", () => {
    let state = modal(createInitialModalState(), "M104 S200");
    state = move(state, 1, "G1 X10").state;
    state = modal(state, "M104 S205");
    const r = move(state, 1, "G1 X20");
    expect(r.move.temperature).toBe(205);
  });

  it("a non-finite M104 value is rejected, never trusted as a real temperature", () => {
    const state = modal(createInitialModalState(), "M104 S1e400");
    expect(move(state, 1, "G1 X10").move.temperature).toBeNull();
  });
});
