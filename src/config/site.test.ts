/**
 * Phase 7: the production-domain blocker + MeshWrench rebrand. Strict
 * TDD regression tests written BEFORE `site.ts` was updated, confirmed
 * failing against the placeholder configuration first.
 */
import { describe, expect, it } from "vitest";
import { siteConfig } from "./site";
import { PRODUCTION_SITE_URL, validateProductionSiteUrl } from "./site-url";

describe("siteConfig.siteUrl — Phase 7: single validated canonical origin", () => {
  it("is exactly the approved production origin, never the example.com placeholder", () => {
    expect(siteConfig.siteUrl).toBe("https://meshwrench.com");
    expect(siteConfig.siteUrl).not.toBe("https://example.com");
  });

  it("is the SAME value as PRODUCTION_SITE_URL — the single source of truth, never a second hardcoded copy", () => {
    expect(siteConfig.siteUrl).toBe(PRODUCTION_SITE_URL);
  });

  it("passes the full production-url validator", () => {
    expect(validateProductionSiteUrl(siteConfig.siteUrl)).toEqual({ ok: true });
  });

  it("has no trailing slash", () => {
    expect(siteConfig.siteUrl.endsWith("/")).toBe(false);
  });

  it("is never localhost or a loopback address", () => {
    expect(siteConfig.siteUrl).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("is never the www subdomain", () => {
    expect(siteConfig.siteUrl).not.toMatch(/^https:\/\/www\./);
  });
});

describe("siteConfig — MeshWrench brand", () => {
  it("productName is MeshWrench, not the old placeholder brand", () => {
    expect(siteConfig.productName).toBe("MeshWrench");
  });

  it("defaultTitle carries the new brand and positioning", () => {
    expect(siteConfig.defaultTitle).toContain("MeshWrench");
    expect(siteConfig.defaultTitle).not.toContain("MeshKit");
  });

  it("defaultDescription never references the old placeholder brand name", () => {
    expect(siteConfig.defaultDescription).not.toContain("MeshKit");
  });
});
