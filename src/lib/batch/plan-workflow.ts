/**
 * The shared two-stage batch workflow every planning-capable operation
 * (repair, optimization) uses: `files selected → analyze/plan each file
 * → show aggregate plan → user confirms → jobs run`. Repair jobs never
 * mutate a file the instant it's selected — the same "see a plan before
 * mutation" guarantee the single-file repair page already gives.
 *
 * Generic over `TSettings` (the operation's own settings shape) and
 * `TPlan` (whatever that operation's own planning step returns) so both
 * `repair-plan.ts` and `optimize-plan.ts` build on this one engine
 * instead of two parallel state machines.
 */
import type { SafeError } from "../errors";
import { createSafeError, isSafeError } from "../errors";

export type PlanEntryState = "pending" | "planning" | "planned" | "failed" | "stale";

export interface PlanEntry<TPlan> {
  readonly id: string;
  readonly file: File;
  readonly displayName: string;
  state: PlanEntryState;
  plan: TPlan | null;
  error: SafeError | null;
}

export type PlanFn<TSettings, TPlan> = (file: File, settings: TSettings) => Promise<TPlan>;

let entrySequence = 0;
function nextEntryId(): string {
  entrySequence += 1;
  return `plan-entry-${entrySequence}`;
}

export class PlanWorkflow<TSettings, TPlan> {
  private entries: PlanEntry<TPlan>[] = [];
  private settings: TSettings;
  private confirmed = false;
  private cancelRequested = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly planFile: PlanFn<TSettings, TPlan>,
    initialSettings: TSettings,
  ) {
    this.settings = initialSettings;
  }

  getEntries(): readonly PlanEntry<TPlan>[] {
    return this.entries;
  }

  getSettings(): TSettings {
    return this.settings;
  }

  addFile(file: File, displayName: string): string {
    const id = nextEntryId();
    this.entries.push({ id, file, displayName, state: "pending", plan: null, error: null });
    this.confirmed = false;
    this.notify();
    return id;
  }

  removeFile(entryId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== entryId);
    const removed = this.entries.length !== before;
    if (removed) this.notify();
    return removed;
  }

  /** Bumping settings invalidates every already-planned entry (marks it `"stale"`) — a stale entry can't be confirmed until it's re-planned under the new settings. */
  updateSettings(next: TSettings): void {
    this.settings = next;
    this.confirmed = false;
    for (const entry of this.entries) {
      if (entry.state === "planned" || entry.state === "failed") entry.state = "stale";
    }
    this.notify();
  }

  /** Plans every entry not already `"planned"` (so a repeat call is idempotent for entries that don't need it). Stops early if `cancelPlanning()` is called mid-run — entries not yet reached stay `"pending"`. */
  async planAll(): Promise<void> {
    this.cancelRequested = false;
    for (const entry of this.entries) {
      if (this.cancelRequested) break;
      if (entry.state === "planned") continue;

      entry.state = "planning";
      this.notify();
      try {
        const plan = await this.planFile(entry.file, this.settings);
        entry.plan = plan;
        entry.error = null;
        entry.state = "planned";
      } catch (err) {
        entry.plan = null;
        // `planFile` implementations (`planRepairFile`/`planOptimizeFile`)
        // already convert their own domain exceptions into a specific
        // `SafeError` before rejecting — preserve that instead of
        // collapsing every failure into a generic, unhelpful message.
        entry.error = isSafeError(err) ? err : createSafeError("UNKNOWN_ERROR");
        entry.state = "failed";
      }
      this.notify();
    }
  }

  cancelPlanning(): void {
    this.cancelRequested = true;
  }

  /** Only succeeds when there's at least one file and every entry has reached a TERMINAL planning state (`"planned"` or `"failed"`) — never while anything is `"pending"`, `"planning"`, or `"stale"`. A mixed batch (some planned, some failed) is a valid confirmation; the failed ones simply won't run. */
  confirm(): boolean {
    if (this.entries.length === 0) return false;
    const allTerminal = this.entries.every((e) => e.state === "planned" || e.state === "failed");
    if (!allTerminal) return false;
    this.confirmed = true;
    this.notify();
    return true;
  }

  isConfirmed(): boolean {
    return this.confirmed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.entries = [];
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
