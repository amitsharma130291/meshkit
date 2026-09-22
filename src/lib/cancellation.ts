/**
 * A single-threaded worker can't process an incoming `postMessage` while
 * it's in the middle of a long synchronous loop — the event loop only
 * gets a turn between ticks. So "cancel a large loop, not just between
 * pipeline stages" requires the loop itself to periodically `await` a
 * real yield point, giving the worker's message handler a chance to run
 * and update whatever cancellation flag `isCancelled` reads.
 *
 * `CancellationRequested` is a generic, format-agnostic signal — thrown
 * by `yieldIfCancelled` and meant to be caught by the orchestrating
 * worker, which should treat it as a `cancelled` response, never as a
 * `SafeError`. Deliberately not tied to any format's `ErrorCode` prefix,
 * so low-level shared utilities (e.g. `src/lib/obj/`'s writer, used by
 * both a converter's input and output side) don't need to import a
 * specific converter's error vocabulary just to support cancellation.
 */
export class CancellationRequested extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancellationRequested";
  }
}

/**
 * Call from inside a large `for`/`while` loop with the loop's current
 * index. Every `every`-th call actually yields (via a macrotask) and
 * checks `isCancelled()`; all other calls return immediately, so this is
 * cheap enough to call unconditionally on every iteration.
 */
export async function yieldIfCancelled(index: number, every: number, isCancelled: (() => boolean) | undefined): Promise<void> {
  if (every <= 0 || index % every !== 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (isCancelled?.()) throw new CancellationRequested();
}
