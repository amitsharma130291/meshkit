/**
 * Phase 7: proves Astro configuration and the runtime SEO config resolve
 * to the exact same production origin — never two independently
 * hardcoded copies that could silently drift apart.
 */
import { describe, expect, it } from "vitest";

describe("astro.config.mjs and src/config/site.ts resolve the identical origin", () => {
  it("astro.config.mjs's `site` equals siteConfig.siteUrl — a single source of truth, not a duplicate", async () => {
    const [{ default: astroConfig }, { siteConfig }] = await Promise.all([import("../../astro.config.mjs"), import("../../src/config/site.ts")]);
    expect(astroConfig.site).toBe(siteConfig.siteUrl);
    expect(astroConfig.site).toBe("https://meshwrench.com");
  });
});
