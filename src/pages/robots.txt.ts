import type { APIRoute } from "astro";
import { siteConfig } from "../config/site";

/**
 * A dynamic endpoint instead of a static `public/robots.txt` file so the
 * `Sitemap:` line can never drift from `siteConfig.siteUrl` — the exact
 * kind of hand-maintained duplicate the Phase 7 SEO audit was built to
 * catch elsewhere (see the homepage-staleness fix in `src/pages/index.astro`
 * and `docs/SEO-LAUNCH-CHECKLIST.md`'s "production-domain blocker" note).
 * Prerendered at build time like every other static route.
 */
export const prerender = true;

export const GET: APIRoute = () => {
  const body = `User-agent: *
Allow: /
Disallow: /foundation-preview/

Sitemap: ${siteConfig.siteUrl}/sitemap-index.xml
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
