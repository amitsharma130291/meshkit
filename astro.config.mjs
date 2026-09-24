import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";
import { siteConfig } from "./src/config/site.ts";

export default defineConfig({
  // Every existing page stays statically prerendered (the default in
  // "static" output). Phase 11's new payment/license API routes each opt
  // into on-demand rendering with their own `export const prerender =
  // false`, which requires the adapter below to serve them as Vercel
  // serverless functions — see docs/ARCHITECTURE.md's Phase 11 section.
  output: "static",
  adapter: vercel(),
  // The single source of truth is src/config/site.ts's `siteUrl` (itself
  // reading — and validating — src/config/site-url.ts's
  // `PRODUCTION_SITE_URL`). Never hardcode a second copy of the domain
  // here — see Phase 7's own completion record in docs/ARCHITECTURE.md.
  site: siteConfig.siteUrl,
  // /online-stl-viewer/ intentionally has no page of its own — it would be
  // near-duplicate content with /stl-viewer/ (same tool, same intent),
  // which risks keyword cannibalization instead of helping either page
  // rank. Astro's own `redirects` (adapter-agnostic, compiled into a real
  // 301 by whichever adapter is active — Vercel's Build Output API
  // `routes`, in this project's case) replaces the old Netlify/Cloudflare-
  // only `public/_redirects` file, which Vercel never read. See
  // docs/ARCHITECTURE.md's "Route strategy" section for the full
  // reasoning behind the redirect itself.
  redirects: {
    "/online-stl-viewer/": "/stl-viewer/",
  },
  integrations: [
    sitemap({
      // /foundation-preview/ is an internal technical test, never a public
      // page. /pro/welcome/ is the post-checkout return_url landing page —
      // a real page, but never a search destination (noindex-utility in
      // scripts/seo-audit/route-manifest.mjs).
      filter: (page) => !page.includes("/foundation-preview/") && !page.includes("/pro/welcome/"),
    }),
  ],
});
