/**
 * A binary min-heap of collapse candidates, ordered by cost. Deliberately
 * does NOT eagerly remove or resort entries when the mesh changes — that
 * would mean "rebuild and resort every edge globally after each
 * collapse," exactly what this phase's own instructions forbid. Instead
 * every entry carries `versionAtInsertion`; `simplify.ts`'s main loop
 * pops the cheapest entry, compares it against the mesh's CURRENT
 * `version` (and whether `from`/`to` are still active), and lazily
 * discards or recomputes it if stale — this module only ever needs to
 * hand back "the cheapest entry currently in the heap," never decide
 * staleness itself.
 */
export interface CollapseCandidate {
  from: number;
  to: number;
  cost: number;
  position: [number, number, number];
  /** The mesh's `version` at the moment this candidate's cost was computed — the staleness signal the caller checks. */
  versionAtInsertion: number;
}

export interface CollapseHeapLimits {
  maxEntries: number;
}

export class HeapCapacityExceededError extends Error {
  constructor() {
    super("collapse heap capacity exceeded");
    this.name = "HeapCapacityExceededError";
  }
}

function edgeKey(c: CollapseCandidate): string {
  const a = Math.min(c.from, c.to);
  const b = Math.max(c.from, c.to);
  return `${a}_${b}`;
}

/** True if `a` must sort before `b` — lower cost first, then lexicographic edge key for a total, deterministic order among ties. */
function before(a: CollapseCandidate, b: CollapseCandidate): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  return edgeKey(a) < edgeKey(b);
}

export class CollapseHeap {
  private entries: CollapseCandidate[] = [];
  private readonly maxEntries: number;

  constructor(limits: CollapseHeapLimits) {
    this.maxEntries = limits.maxEntries;
  }

  size(): number {
    return this.entries.length;
  }

  push(candidate: CollapseCandidate): void {
    if (this.entries.length >= this.maxEntries) throw new HeapCapacityExceededError();
    this.entries.push(candidate);
    this.siftUp(this.entries.length - 1);
  }

  pop(): CollapseCandidate | null {
    if (this.entries.length === 0) return null;
    const top = this.entries[0];
    const last = this.entries.pop()!;
    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(this.entries[i], this.entries[parent])) {
        [this.entries[i], this.entries[parent]] = [this.entries[parent], this.entries[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const n = this.entries.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && before(this.entries[left], this.entries[smallest])) smallest = left;
      if (right < n && before(this.entries[right], this.entries[smallest])) smallest = right;
      if (smallest === i) break;
      [this.entries[i], this.entries[smallest]] = [this.entries[smallest], this.entries[i]];
      i = smallest;
    }
  }
}
