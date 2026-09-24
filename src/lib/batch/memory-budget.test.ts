import { describe, expect, it } from "vitest";
import { MemoryBudget, OPERATION_MEMORY_MULTIPLIERS } from "./memory-budget";

describe("OPERATION_MEMORY_MULTIPLIERS", () => {
  it("defines a conservative multiplier for every batch operation", () => {
    const ids: (keyof typeof OPERATION_MEMORY_MULTIPLIERS)[] = [
      "convert-3mf-to-stl",
      "convert-obj-to-stl",
      "convert-glb-to-stl",
      "convert-ply-to-stl",
      "convert-stl-to-obj",
      "convert-stl-to-3mf",
      "repair-stl",
      "optimize-stl",
    ];
    for (const id of ids) expect(OPERATION_MEMORY_MULTIPLIERS[id]).toBeGreaterThan(1);
  });
});

describe("MemoryBudget — scheduling admission", () => {
  it("admits a small job comfortably within budget", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 100_000_000 });
    expect(budget.canSchedule("job-1", "repair-stl", 1_000_000)).toBe(true);
  });

  it("refuses a job that alone would exceed the total budget", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    expect(budget.canSchedule("job-1", "repair-stl", 5_000_000)).toBe(false);
  });

  it("refuses a job that would exceed budget once combined with already-reserved jobs", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 20_000_000 });
    budget.reserve("job-1", "repair-stl", 3_000_000);
    expect(budget.canSchedule("job-2", "repair-stl", 3_000_000)).toBe(false);
  });

  it("never throws for an oversized job — it just declines admission", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 1000 });
    expect(() => budget.canSchedule("huge", "repair-stl", 10_000_000_000)).not.toThrow();
    expect(budget.canSchedule("huge", "repair-stl", 10_000_000_000)).toBe(false);
  });
});

describe("MemoryBudget — reserve/release accounting", () => {
  it("release() frees the budget a job had reserved", () => {
    // repair-stl's multiplier means a 3MB job alone reserves ~18MB (input + 5x expansion) —
    // pick a budget where one reservation fits but two concurrently don't.
    const budget = new MemoryBudget({ maxTotalBytes: 20_000_000 });
    budget.reserve("job-1", "repair-stl", 3_000_000);
    expect(budget.canSchedule("job-2", "repair-stl", 3_000_000)).toBe(false);
    budget.release("job-1");
    expect(budget.canSchedule("job-2", "repair-stl", 3_000_000)).toBe(true);
  });

  it("releasing an unreserved/unknown job id is a safe no-op", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    expect(() => budget.release("never-reserved")).not.toThrow();
  });

  it("a heavier operation multiplier consumes more of the budget for the same input size", () => {
    const budgetA = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    const budgetB = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    budgetA.reserve("job-1", "convert-stl-to-obj", 1_000_000);
    budgetB.reserve("job-1", "repair-stl", 1_000_000);
    expect(budgetB.currentEstimate().activeInputBytes + budgetB.currentEstimate().estimatedParserExpansionBytes).toBeGreaterThanOrEqual(
      budgetA.currentEstimate().activeInputBytes + budgetA.currentEstimate().estimatedParserExpansionBytes,
    );
  });
});

describe("MemoryBudget — retained outputs and pending ZIP accounting", () => {
  it("retainOutput adds to the tracked total; releaseOutput removes it", () => {
    // convert-stl-to-obj's lighter multiplier keeps a 1MB job's footprint at ~4MB,
    // so a 7MB retained output is what tips a 10MB budget over, not the job itself.
    const budget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    expect(budget.canSchedule("job-2", "convert-stl-to-obj", 1_000_000)).toBe(true);
    budget.retainOutput("job-1", 7_000_000);
    expect(budget.canSchedule("job-2", "convert-stl-to-obj", 1_000_000)).toBe(false);
    budget.releaseOutput("job-1");
    expect(budget.canSchedule("job-2", "convert-stl-to-obj", 1_000_000)).toBe(true);
  });

  it("reserveForZip accounts for a pending ZIP generation's estimated footprint", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    expect(budget.canSchedule("job-1", "convert-stl-to-obj", 1_000_000)).toBe(true);
    expect(budget.reserveForZip(9_000_000)).toBe(true);
    expect(budget.canSchedule("job-1", "convert-stl-to-obj", 1_000_000)).toBe(false);
    budget.releaseZip();
    expect(budget.canSchedule("job-1", "convert-stl-to-obj", 1_000_000)).toBe(true);
  });

  it("reserveForZip refuses and does not partially reserve when it alone exceeds budget", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 1_000_000 });
    expect(budget.reserveForZip(5_000_000)).toBe(false);
    expect(budget.currentEstimate().pendingZipGenerationBytes).toBe(0);
  });
});

describe("MemoryBudget — estimates are approximate, not exact browser usage", () => {
  it("currentEstimate() exposes every tracked category", () => {
    const budget = new MemoryBudget({ maxTotalBytes: 10_000_000 });
    const estimate = budget.currentEstimate();
    expect(estimate).toHaveProperty("scheduledInputBytes");
    expect(estimate).toHaveProperty("activeInputBytes");
    expect(estimate).toHaveProperty("estimatedParserExpansionBytes");
    expect(estimate).toHaveProperty("retainedSuccessfulOutputBytes");
    expect(estimate).toHaveProperty("pendingZipGenerationBytes");
  });
});
