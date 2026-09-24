import { describe, expect, it } from "vitest";
import { resolveProductionSiteUrl } from "./site-url-resolver.mjs";

describe("resolveProductionSiteUrl", () => {
  it("resolves the real production origin even though astro.config.mjs's `site` is a variable reference (siteConfig.siteUrl), not a string literal", () => {
    // astro.config.mjs deliberately reads `site` from src/config/site.ts's
    // `siteConfig.siteUrl` instead of duplicating the domain as a literal
    // (see astro.config.mjs's own comment on why). A naive regex over
    // astro.config.mjs's source text alone can't see through that
    // indirection, so this resolver must also fall back to the underlying
    // config files.
    expect(resolveProductionSiteUrl()).toBe("https://meshwrench.com");
  });
});
