import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  output: "static",
  // Update alongside src/config/site.ts's `siteUrl` once a real domain is set.
  site: "https://example.com",
  integrations: [
    sitemap({
      // /foundation-preview/ is an internal technical test, never a public page.
      filter: (page) => !page.includes("/foundation-preview/"),
    }),
  ],
});
