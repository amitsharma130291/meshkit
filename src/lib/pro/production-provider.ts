/**
 * The production entitlement provider — used by every page in the real
 * build. Phase 11 gives it exactly one legitimate unlock path: a license
 * key the user activated (via /pricing/'s "have a license key" form, or
 * automatically right after a successful purchase — see
 * src/pages/pro/welcome). That key is remembered in `localStorage`
 * (`license-storage.ts`) purely as "what to check" — it is NEVER, by
 * itself, sufficient to grant Pro. Every resolution always awaits a real
 * server round-trip to `/api/license/verify`, which proxies Dodo
 * Payments' own license-validation endpoint. Until that call resolves
 * (or if there is no stored key at all, or the call fails), the
 * snapshot is never `"pro"` — see `production-provider.test.ts`'s
 * source-level guarantee that no code path here resolves `"pro"`
 * synchronously or without an awaited fetch.
 */
import { createEntitlementProvider, type EntitlementProviderController } from "./entitlement-provider";
import { createSnapshot, FAIL_CLOSED_SNAPSHOT } from "./entitlement-types";
import { ALL_PRO_CAPABILITIES } from "./capabilities";
import { getStoredLicense } from "./license-storage";

async function verifyStoredLicense(): Promise<ReturnType<typeof createSnapshot>> {
  const stored = getStoredLicense(window.localStorage);
  if (!stored) {
    return createSnapshot("free", [], "production-default", Date.now());
  }
  try {
    const res = await fetch("/api/license/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey: stored.licenseKey }),
    });
    if (!res.ok) {
      return createSnapshot("unavailable", [], "license-key", Date.now());
    }
    const body: { valid?: boolean } = await res.json();
    if (body.valid) {
      return createSnapshot("pro", ALL_PRO_CAPABILITIES, "license-key", Date.now());
    }
    return createSnapshot("invalid", [], "license-key", Date.now());
  } catch {
    // Network failure — fail closed, never assume pro from a stored key alone.
    return createSnapshot("unavailable", [], "license-key", Date.now());
  }
}

/**
 * A local-machine-only testing aid, nothing more. Lets you see the Pro
 * UI without a real Dodo purchase while you don't yet have a test
 * license key to activate. Two independent gates, both required:
 *   1. `import.meta.env.DEV` — true only under `astro dev`. Vite/Astro
 *      bakes this to `false` for every production build (including
 *      Vercel's), so this branch is physically absent from anything
 *      that ships, regardless of what env vars happen to be set there.
 *   2. `PUBLIC_LOCAL_TEST_UNLOCK_PRO` — off unless you explicitly add
 *      it to your own local `.env`/`.env.local` (see .env.example).
 * Delete your local var (or just leave it unset) to go back to testing
 * the real license-key flow at any time.
 */
function localTestProOverride(): ReturnType<typeof createSnapshot> | null {
  if (!import.meta.env.DEV) return null;
  if (import.meta.env.PUBLIC_LOCAL_TEST_UNLOCK_PRO !== "true") return null;
  return createSnapshot("pro", ALL_PRO_CAPABILITIES, "license-key", Date.now());
}

export function createProductionEntitlementProvider(): EntitlementProviderController {
  const controller = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
  const localOverride = localTestProOverride();
  controller.resolveAsync(localOverride ? Promise.resolve(localOverride) : verifyStoredLicense());
  return controller;
}
