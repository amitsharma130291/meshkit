// Resolves the real production origin for the SEO audit to check against,
// without needing a TS-aware loader to actually import astro.config.mjs /
// src/config/site.ts at plain-Node runtime (see docs/ARCHITECTURE.md's
// Phase 7 note on why those imports work under Vite/vitest but not plain
// Node). astro.config.mjs's `site` deliberately reads
// src/config/site.ts's `siteConfig.siteUrl` rather than duplicating the
// domain as a literal, so a regex over astro.config.mjs's own source text
// alone can no longer see the value — this falls back to the underlying
// config files, which is where the literal actually lives.
import { readFileSync } from "node:fs";
import path from "node:path";

function readFileIfMatches(relativePath, pattern) {
  const filePath = path.resolve(process.cwd(), relativePath);
  const source = readFileSync(filePath, "utf8");
  const match = source.match(pattern);
  return match ? match[1] : null;
}

export function resolveProductionSiteUrl() {
  const fromAstroConfig = readFileIfMatches("astro.config.mjs", /site:\s*["'`](.+?)["'`]/);
  if (fromAstroConfig) return fromAstroConfig;

  const fromSiteUrlModule = readFileIfMatches(
    "src/config/site-url.ts",
    /export const PRODUCTION_SITE_URL\s*=\s*["'`](.+?)["'`]/,
  );
  if (fromSiteUrlModule) return fromSiteUrlModule;

  return readFileIfMatches("src/config/site.ts", /siteUrl:\s*["'`](.+?)["'`]/);
}
