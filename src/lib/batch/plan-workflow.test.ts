import { describe, expect, it, vi } from "vitest";
import { PlanWorkflow } from "./plan-workflow";
import { createSafeError } from "../errors";

interface FakePlan {
  issues: string[];
}

function makeFile(name = "part.stl"): File {
  return new File([new Uint8Array(8)], name, { type: "model/stl" });
}

function planner(behavior: (file: File, settings: { weld: boolean }) => Promise<FakePlan>) {
  return behavior;
}

describe("PlanWorkflow — files selected -> analyze/plan -> aggregate -> confirm", () => {
  it("all files planned successfully move to the planned state", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    workflow.addFile(makeFile("b.stl"), "b.stl");
    await workflow.planAll();
    const states = workflow.getEntries().map((e) => e.state);
    expect(states).toEqual(["planned", "planned"]);
  });

  it("does not plan automatically on addFile — planning is an explicit step", () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    expect(workflow.getEntries()[0].state).toBe("pending");
  });

  it("mixed plan success/failure — one file's planner throwing doesn't stop the others", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async (file) => {
        if (file.name === "bad.stl") throw new Error("cannot analyze");
        return { issues: [] };
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("bad.stl"), "bad.stl");
    workflow.addFile(makeFile("good.stl"), "good.stl");
    await workflow.planAll();
    const byName = new Map(workflow.getEntries().map((e) => [e.displayName, e]));
    expect(byName.get("bad.stl")!.state).toBe("failed");
    expect(byName.get("good.stl")!.state).toBe("planned");
  });

  it("preserves a SafeError a planFn rejects with, rather than collapsing it into a generic UNKNOWN_ERROR", async () => {
    const specificError = createSafeError("STLDIAG_ANALYSIS_BUDGET_EXCEEDED");
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async () => {
        throw specificError;
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("slow.stl"), "slow.stl");
    await workflow.planAll();
    const entry = workflow.getEntries()[0];
    expect(entry.state).toBe("failed");
    expect(entry.error).toEqual(specificError);
    expect(entry.error?.code).toBe("STLDIAG_ANALYSIS_BUDGET_EXCEEDED");
  });

  it("falls back to a generic UNKNOWN_ERROR when a planFn throws something that isn't already a SafeError", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async () => {
        throw new TypeError("boom");
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("odd.stl"), "odd.stl");
    await workflow.planAll();
    const entry = workflow.getEntries()[0];
    expect(entry.state).toBe("failed");
    expect(entry.error?.code).toBe("UNKNOWN_ERROR");
  });
});

describe("PlanWorkflow — settings changes invalidate existing plans", () => {
  it("updateSettings marks every already-planned entry stale", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    expect(workflow.getEntries()[0].state).toBe("planned");

    workflow.updateSettings({ weld: true });
    expect(workflow.getEntries()[0].state).toBe("stale");
  });

  it("re-running planAll() after a settings change re-plans only the stale entries", async () => {
    const seen: boolean[] = [];
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async (_file, settings) => {
        seen.push(settings.weld);
        return { issues: [] };
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    workflow.updateSettings({ weld: true });
    await workflow.planAll();
    expect(seen).toEqual([false, true]);
    expect(workflow.getEntries()[0].state).toBe("planned");
  });
});

describe("PlanWorkflow — adding/removing files after planning", () => {
  it("a file added after planning starts pending, without disturbing already-planned entries", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    workflow.addFile(makeFile("b.stl"), "b.stl");

    const byName = new Map(workflow.getEntries().map((e) => [e.displayName, e]));
    expect(byName.get("a.stl")!.state).toBe("planned");
    expect(byName.get("b.stl")!.state).toBe("pending");
  });

  it("a file removed after planning is gone from getEntries()", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    const id = workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    expect(workflow.removeFile(id)).toBe(true);
    expect(workflow.getEntries()).toHaveLength(0);
  });
});

describe("PlanWorkflow — confirmation", () => {
  it("confirm() succeeds once every entry has reached a terminal planning state", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    expect(workflow.confirm()).toBe(true);
    expect(workflow.isConfirmed()).toBe(true);
  });

  it("confirm() succeeds even with some FAILED entries — a mixed batch is a valid confirmation", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async (file) => {
        if (file.name === "bad.stl") throw new Error("nope");
        return { issues: [] };
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("bad.stl"), "bad.stl");
    workflow.addFile(makeFile("good.stl"), "good.stl");
    await workflow.planAll();
    expect(workflow.confirm()).toBe(true);
  });

  it("confirm() refuses while any entry is still pending (not yet planned)", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    expect(workflow.confirm()).toBe(false);
    expect(workflow.isConfirmed()).toBe(false);
  });

  it("confirm() refuses while any entry is stale (settings changed since it was planned)", async () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    workflow.updateSettings({ weld: true });
    expect(workflow.confirm()).toBe(false);
  });

  it("confirm() refuses with zero files", () => {
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(planner(async () => ({ issues: [] })), { weld: false });
    expect(workflow.confirm()).toBe(false);
  });
});

describe("PlanWorkflow — cancellation during planning", () => {
  it("cancelPlanning() stops planning further pending entries, leaving already-planned ones intact", async () => {
    let resolveSecond!: () => void;
    const order: string[] = [];
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(
      planner(async (file) => {
        order.push(file.name);
        if (file.name === "b.stl") {
          await new Promise<void>((resolve) => (resolveSecond = resolve));
        }
        return { issues: [] };
      }),
      { weld: false },
    );
    workflow.addFile(makeFile("a.stl"), "a.stl");
    workflow.addFile(makeFile("b.stl"), "b.stl");
    workflow.addFile(makeFile("c.stl"), "c.stl");

    const planPromise = workflow.planAll();
    // Let "a" finish and "b" start (and hang), then cancel before "c" ever begins.
    await new Promise((resolve) => setTimeout(resolve, 10));
    workflow.cancelPlanning();
    resolveSecond();
    await planPromise;

    const byName = new Map(workflow.getEntries().map((e) => [e.displayName, e]));
    expect(byName.get("a.stl")!.state).toBe("planned");
    expect(byName.get("c.stl")!.state).toBe("pending"); // never reached
  });
});

describe("PlanWorkflow — stale plans and repeated planning", () => {
  it("repeated planAll() calls are idempotent for already-planned entries (planner not called again)", async () => {
    const plannerFn = vi.fn(async () => ({ issues: [] }));
    const workflow = new PlanWorkflow<{ weld: boolean }, FakePlan>(plannerFn, { weld: false });
    workflow.addFile(makeFile("a.stl"), "a.stl");
    await workflow.planAll();
    await workflow.planAll();
    expect(plannerFn).toHaveBeenCalledTimes(1);
  });
});
