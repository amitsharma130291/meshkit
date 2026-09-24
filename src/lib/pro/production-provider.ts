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

export function createProductionEntitlementProvider(): EntitlementProviderController {
  const controller = createEntitlementProvider(FAIL_CLOSED_SNAPSHOT);
  controller.resolveAsync(verifyStoredLicense());
  return controller;
}
