import { describe, expect, it } from "vitest";
import { CollapseHeap, HeapCapacityExceededError, type CollapseCandidate } from "./collapse-heap";

function candidate(overrides: Partial<CollapseCandidate>): CollapseCandidate {
  return {
    from: 0,
    to: 1,
    cost: 1,
    position: [0, 0, 0],
    versionAtInsertion: 0,
    ...overrides,
  };
}

describe("CollapseHeap — ordering", () => {
  it("pops the lowest-cost candidate first", () => {
    const heap = new CollapseHeap({ maxEntries: 100 });
    heap.push(candidate({ from: 0, to: 1, cost: 5 }));
    heap.push(candidate({ from: 2, to: 3, cost: 1 }));
    heap.push(candidate({ from: 4, to: 5, cost: 3 }));
    expect(heap.pop()!.cost).toBe(1);
    expect(heap.pop()!.cost).toBe(3);
    expect(heap.pop()!.cost).toBe(5);
    expect(heap.pop()).toBeNull();
  });

  it("orders correctly under interleaved pushes and pops", () => {
    const heap = new CollapseHeap({ maxEntries: 100 });
    heap.push(candidate({ from: 0, to: 1, cost: 10 }));
    heap.push(candidate({ from: 2, to: 3, cost: 2 }));
    expect(heap.pop()!.cost).toBe(2);
    heap.push(candidate({ from: 4, to: 5, cost: 1 }));
    heap.push(candidate({ from: 6, to: 7, cost: 20 }));
    expect(heap.pop()!.cost).toBe(1);
    expect(heap.pop()!.cost).toBe(10);
    expect(heap.pop()!.cost).toBe(20);
  });
});

describe("CollapseHeap — deterministic tie-breaking", () => {
  it("breaks equal-cost ties by (from,to) edge key, independent of insertion order", () => {
    const heapA = new CollapseHeap({ maxEntries: 100 });
    heapA.push(candidate({ from: 5, to: 6, cost: 1 }));
    heapA.push(candidate({ from: 1, to: 2, cost: 1 }));
    heapA.push(candidate({ from: 3, to: 4, cost: 1 }));

    const heapB = new CollapseHeap({ maxEntries: 100 });
    heapB.push(candidate({ from: 3, to: 4, cost: 1 }));
    heapB.push(candidate({ from: 5, to: 6, cost: 1 }));
    heapB.push(candidate({ from: 1, to: 2, cost: 1 }));

    const orderA = [heapA.pop(), heapA.pop(), heapA.pop()].map((c) => `${c!.from}_${c!.to}`);
    const orderB = [heapB.pop(), heapB.pop(), heapB.pop()].map((c) => `${c!.from}_${c!.to}`);
    expect(orderA).toEqual(orderB);
    expect(orderA).toEqual(["1_2", "3_4", "5_6"]);
  });
});

describe("CollapseHeap — lazy invalidation", () => {
  it("peek/pop exposes the candidate's insertion-time version so the caller can detect staleness itself", () => {
    const heap = new CollapseHeap({ maxEntries: 100 });
    heap.push(candidate({ from: 0, to: 1, cost: 1, versionAtInsertion: 3 }));
    const popped = heap.pop()!;
    expect(popped.versionAtInsertion).toBe(3);
  });

  it("size() reflects pushes and pops without eagerly removing anything else (no global rebuild)", () => {
    const heap = new CollapseHeap({ maxEntries: 100 });
    heap.push(candidate({ from: 0, to: 1, cost: 5 }));
    heap.push(candidate({ from: 2, to: 3, cost: 1 }));
    expect(heap.size()).toBe(2);
    heap.pop();
    expect(heap.size()).toBe(1);
  });
});

describe("CollapseHeap — safety ceiling", () => {
  it("throws when pushed beyond the configured maximum entries", () => {
    const heap = new CollapseHeap({ maxEntries: 2 });
    heap.push(candidate({ from: 0, to: 1, cost: 1 }));
    heap.push(candidate({ from: 2, to: 3, cost: 2 }));
    expect(() => heap.push(candidate({ from: 4, to: 5, cost: 3 }))).toThrow(HeapCapacityExceededError);
  });
});
