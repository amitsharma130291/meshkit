/**
 * Phase 7: the single, validated source of truth for the production
 * canonical origin. `src/config/site.ts`'s `siteUrl` and
 * `astro.config.mjs`'s `site` both read `PRODUCTION_SITE_URL` from
 * here — never a second hardcoded copy — so the two can never drift
 * apart, and `validateProductionSiteUrl()` is called on it at module
 * load (see `site.ts`) so a future accidental regression to a
 * placeholder, localhost, or a malformed origin fails loudly at build
 * time instead of silently shipping.
 */
export interface SiteUrlValidation {
  ok: boolean;
  reason?: string;
}

const PLACEHOLDER_HOSTNAMES = new Set(["example.com", "example.org", "example.net"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Validates a candidate production canonical origin against every rule
 * Phase 7 requires: must parse as a URL, must be HTTPS, must not be a
 * known placeholder or local/loopback host, must be the bare apex
 * origin (no path, no query string, no trailing slash), and must never
 * be the `www` subdomain (which should permanently redirect to the
 * apex, never serve as the canonical origin itself).
 */
export function validateProductionSiteUrl(candidate: string): SiteUrlValidation {
  if (candidate.length === 0) return { ok: false, reason: "empty origin — a production site URL must be set" };

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "not a valid, well-formed URL" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: `must use https — got "${parsed.protocol}"` };

  const hostname = parsed.hostname.toLowerCase();
  if (PLACEHOLDER_HOSTNAMES.has(hostname)) return { ok: false, reason: `"${hostname}" is a placeholder domain, never a real production origin` };
  if (LOCAL_HOSTNAMES.has(hostname)) return { ok: false, reason: `"${hostname}" is a localhost/loopback address, never a production origin` };
  if (hostname.startsWith("www.")) return { ok: false, reason: "www subdomain must never be the canonical origin — it should permanently redirect to the apex domain instead" };

  if (parsed.pathname !== "/" && parsed.pathname !== "") return { ok: false, reason: `must not include a path — got "${parsed.pathname}"` };
  if (parsed.search !== "") return { ok: false, reason: `must not include a query string — got "${parsed.search}"` };
  if (parsed.hash !== "") return { ok: false, reason: `must not include a fragment — got "${parsed.hash}"` };

  // `new URL()` normalizes a bare origin's pathname to "/" even when the
  // input had none — compare the ORIGINAL string to distinguish
  // "https://meshwrench.com" (canonical, no trailing slash) from
  // "https://meshwrench.com/" (a trailing-slash inconsistency, rejected).
  if (candidate.endsWith("/")) return { ok: false, reason: "must not have a trailing slash — the canonical form is the bare origin" };

  return { ok: true };
}

/** The single approved canonical production origin for MeshWrench. */
export const PRODUCTION_SITE_URL = "https://meshwrench.com";
