import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { siteConfig } from "./src/config/site.ts";

export default defineConfig({
  output: "static",
  // The single source of truth is src/config/site.ts's `siteUrl` (itself
  // reading — and validating — src/config/site-url.ts's
  // `PRODUCTION_SITE_URL`). Never hardcode a second copy of the domain
  // here — see Phase 7's own completion record in docs/ARCHITECTURE.md.
  site: siteConfig.siteUrl,
  integrations: [
    sitemap({
      // /foundation-preview/ is an internal technical test, never a public page.
      filter: (page) => !page.includes("/foundation-preview/"),
    }),
  ],
});
