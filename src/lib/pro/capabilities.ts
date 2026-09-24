/**
 * The exhaustive Phase 10 Pro capability list. Every gate check in this
 * project (`feature-gate.ts`) compares against one of these exact keys —
 * never a free-form string — so a typo'd capability name fails a type
 * check instead of silently granting nothing (or, worse, being coerced
 * into "truthy" somewhere).
 */
export type ProCapability =
  | "batch-conversion"
  | "batch-repair"
  | "batch-optimization"
  | "multi-file-queue"
  | "saved-presets"
  | "batch-zip-download"
  /** Reserved for a future capability — no advertising functionality exists in Phase 10. */
  | "ad-free";

const CAPABILITY_VALUES: readonly ProCapability[] = [
  "batch-conversion",
  "batch-repair",
  "batch-optimization",
  "multi-file-queue",
  "saved-presets",
  "batch-zip-download",
  "ad-free",
];

export function isProCapability(value: string): value is ProCapability {
  return (CAPABILITY_VALUES as readonly string[]).includes(value);
}

/** Traps mutation at runtime (not just the `ReadonlySet` type) so "capability sets are immutable" is an enforced guarantee, not a convention callers can accidentally break. */
export function freezeCapabilitySet(capabilities: Iterable<ProCapability>): ReadonlySet<ProCapability> {
  const real = new Set(capabilities);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "add" || prop === "delete" || prop === "clear") {
        return () => {
          throw new Error("Capability sets are immutable — this set cannot be mutated after creation.");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReadonlySet<ProCapability>;
}

export const ALL_PRO_CAPABILITIES: ReadonlySet<ProCapability> = freezeCapabilitySet(CAPABILITY_VALUES);
