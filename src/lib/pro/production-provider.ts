/**
 * The production entitlement provider — used by every page in the real
 * build. Until Phase 11 (Dodo Payments + license issuance) exists, this
 * MUST always resolve to `"free"` with zero capabilities. This file
 * deliberately never reads a query string, `localStorage`,
 * `sessionStorage`, a URL hash, or a global — there is no unlock
 * mechanism here at all, by design, not by omission. See
 * `production-provider.test.ts`'s source-level guarantee tests and
 * `production-isolation.test.ts`'s built-bundle inspection.
 */
import { createEntitlementProvider, type EntitlementProviderController } from "./entitlement-provider";
import { createSnapshot } from "./entitlement-types";

export function createProductionEntitlementProvider(): EntitlementProviderController {
  return createEntitlementProvider(createSnapshot("free", [], "production-default", Date.now()));
}
