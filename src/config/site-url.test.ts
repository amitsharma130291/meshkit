/**
 * Phase 7: the production-domain blocker. Strict TDD regression tests
 * for the single validated production origin, written BEFORE the
 * implementation existed and confirmed failing for the right reason
 * (module not found) — see the Phase 7 completion report for the
 * captured failure output.
 */
import { describe, expect, it } from "vitest";
import { validateProductionSiteUrl } from "./site-url";

describe("validateProductionSiteUrl — rejects every placeholder/invalid shape", () => {
  it("rejects the placeholder example.com origin", () => {
    const result = validateProductionSiteUrl("https://example.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/placeholder|example\.com/i);
  });

  it("rejects localhost", () => {
    const result = validateProductionSiteUrl("https://localhost");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/localhost/i);
  });

  it("rejects a localhost origin with a port", () => {
    const result = validateProductionSiteUrl("http://localhost:4321");
    expect(result.ok).toBe(false);
  });

  it("rejects the 127.0.0.1 loopback address", () => {
    const result = validateProductionSiteUrl("https://127.0.0.1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/localhost|loopback|127\.0\.0\.1/i);
  });

  it("rejects plain HTTP (must be HTTPS)", () => {
    const result = validateProductionSiteUrl("http://meshwrench.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/https/i);
  });

  it("rejects an empty string", () => {
    const result = validateProductionSiteUrl("");
    expect(result.ok).toBe(false);
  });

  it("rejects an origin with a path", () => {
    const result = validateProductionSiteUrl("https://meshwrench.com/tools");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/path/i);
  });

  it("rejects an origin with a query string", () => {
    const result = validateProductionSiteUrl("https://meshwrench.com?ref=x");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/quer/i);
  });

  it("rejects a trailing-slash origin (the canonical form has none)", () => {
    const result = validateProductionSiteUrl("https://meshwrench.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/trailing/i);
  });

  it("rejects www.meshwrench.com as a canonical origin — www must redirect, never be canonical", () => {
    const result = validateProductionSiteUrl("https://www.meshwrench.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/www/i);
  });

  it("rejects a malformed, unparseable URL", () => {
    const result = validateProductionSiteUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  it("rejects a bare hostname with no scheme", () => {
    const result = validateProductionSiteUrl("meshwrench.com");
    expect(result.ok).toBe(false);
  });

  it("accepts exactly https://meshwrench.com — the single approved canonical origin", () => {
    const result = validateProductionSiteUrl("https://meshwrench.com");
    expect(result).toEqual({ ok: true });
  });
});

describe("PRODUCTION_SITE_URL — the single source of truth", () => {
  it("is exactly the approved canonical origin", async () => {
    const { PRODUCTION_SITE_URL } = await import("./site-url");
    expect(PRODUCTION_SITE_URL).toBe("https://meshwrench.com");
  });

  it("passes its own validator (the config can never silently regress to a placeholder)", async () => {
    const { PRODUCTION_SITE_URL, validateProductionSiteUrl: validate } = await import("./site-url");
    expect(validate(PRODUCTION_SITE_URL)).toEqual({ ok: true });
  });
});
