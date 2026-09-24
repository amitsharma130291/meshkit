// Checks that need the whole site's data at once (as opposed to
// checks.mjs's per-page rules): title/description uniqueness, sitemap
// agreement, robots.txt agreement, and the internal link graph.
import { normalizePathname, isPlaceholderOrigin } from "./url-utils.mjs";
import { isIndexableClassification } from "./route-manifest.mjs";

/** Exact-duplicate titles/descriptions are critical; near-duplicates are warnings. */
export function checkUniqueness(pagesByPathname) {
  const critical = [];
  const warnings = [];
  const titleOwners = new Map();
  const descriptionOwners = new Map();

  for (const [pathname, page] of pagesByPathname) {
    if (page.title) {
      const key = page.title.trim();
      if (titleOwners.has(key)) {
        critical.push(`duplicate <title> "${key}" used by both "${titleOwners.get(key)}" and "${pathname}"`);
      } else {
        titleOwners.set(key, pathname);
      }
    }
    if (page.description) {
      const key = page.description.trim();
      if (descriptionOwners.has(key)) {
        critical.push(`duplicate meta description used by both "${descriptionOwners.get(key)}" and "${pathname}"`);
      } else {
        descriptionOwners.set(key, pathname);
      }
    }
  }

  // Suspiciously similar (not exact) descriptions: same first 40 chars.
  const prefixOwners = new Map();
  for (const [pathname, page] of pagesByPathname) {
    if (!page.description) continue;
    const prefix = page.description.trim().slice(0, 40).toLowerCase();
    if (prefixOwners.has(prefix) && prefixOwners.get(prefix) !== pathname) {
      warnings.push(`meta description on "${pathname}" starts identically to "${prefixOwners.get(prefix)}" — check for near-duplicate copy`);
    } else {
      prefixOwners.set(prefix, pathname);
    }
  }

  return { critical, warnings };
}

/** Cross-checks the parsed sitemap URL set against the route manifest's expected indexable set. */
export function checkSitemap(sitemapUrls, routeManifest) {
  const critical = [];
  const warnings = [];

  const sitemapPaths = sitemapUrls.map((u) => normalizePathname(u));
  const seen = new Set();
  for (const path of sitemapPaths) {
    if (seen.has(path)) critical.push(`duplicate <loc> entry in sitemap: "${path}"`);
    seen.add(path);
  }

  const placeholderCount = sitemapUrls.filter((url) => isPlaceholderOrigin(url)).length;
  if (placeholderCount > 0) {
    critical.push(`${placeholderCount} sitemap entr${placeholderCount === 1 ? "y uses" : "ies use"} a placeholder production origin (e.g. "${sitemapUrls.find((u) => isPlaceholderOrigin(u))}") — see the config-level launch blocker`);
  }
  for (const url of sitemapUrls) {
    if (!url.startsWith("https://") && !isPlaceholderOrigin(url)) critical.push(`sitemap entry is not an absolute https URL: "${url}"`);
  }

  for (const route of routeManifest) {
    const shouldBeInSitemap = isIndexableClassification(route.classification);
    const inSitemap = sitemapPaths.includes(normalizePathname(route.pathname));
    if (shouldBeInSitemap && !inSitemap) {
      critical.push(`indexable route missing from sitemap: "${route.pathname}"`);
    }
    if (!shouldBeInSitemap && inSitemap) {
      critical.push(`${route.classification} route "${route.pathname}" unexpectedly appears in the sitemap`);
    }
  }

  return { critical, warnings };
}

/** Cross-checks robots.txt's Disallow lines against development-only routes, and Sitemap: against siteUrl. */
export function checkRobotsTxt(robotsTxt, routeManifest) {
  const critical = [];
  const warnings = [];

  if (!/^User-agent:/im.test(robotsTxt)) critical.push("robots.txt has no User-agent directive — invalid syntax");
  if (/^Disallow:\s*\/\s*$/im.test(robotsTxt)) critical.push("robots.txt disallows the entire site (\"Disallow: /\")");

  const sitemapLine = robotsTxt.match(/^Sitemap:\s*(\S+)/im);
  if (!sitemapLine) {
    critical.push("robots.txt has no Sitemap: line");
  } else {
    if (isPlaceholderOrigin(sitemapLine[1])) critical.push(`robots.txt Sitemap: URL uses a placeholder origin: "${sitemapLine[1]}"`);
  }

  for (const route of routeManifest.filter((r) => r.classification === "development-only")) {
    const disallowed = new RegExp(`^Disallow:\\s*${route.pathname.replace(/\//g, "\\/")}`, "im").test(robotsTxt);
    if (!disallowed) warnings.push(`development-only route "${route.pathname}" is not blocked in robots.txt (relying on noindex meta alone)`);
  }

  return { critical, warnings };
}

/**
 * Builds the internal link graph across all indexable pages and reports:
 * broken internal links (an href to a path that isn't a real built route)
 * and orphan pages (an indexable page no other indexable page links to,
 * excluding the homepage which is the graph's own root).
 */
export function checkLinkGraph(pagesByPathname, routeManifest) {
  const critical = [];
  const warnings = [];

  const builtPaths = new Set([...pagesByPathname.keys()].map((p) => normalizePathname(p)));
  const redirectSources = new Set(routeManifest.filter((r) => r.redirectsTo).map((r) => normalizePathname(r.pathname)));
  const linkedFrom = new Map();

  for (const [pathname, page] of pagesByPathname) {
    for (const link of page.links) {
      if (/^https?:\/\//.test(link.href) || link.href.startsWith("mailto:") || link.href.startsWith("tel:")) continue;
      if (link.href.startsWith("#")) continue;

      const [pathPart] = link.href.split("#");
      if (!pathPart) continue;
      const normalized = normalizePathname(pathPart);

      const resolvable = builtPaths.has(normalized) || redirectSources.has(normalized) || normalized === "/robots.txt" || normalized.startsWith("/sitemap");
      if (!resolvable) {
        critical.push(`broken internal link on "${pathname}": href="${link.href}"`);
        continue;
      }
      if (!linkedFrom.has(normalized)) linkedFrom.set(normalized, new Set());
      linkedFrom.get(normalized).add(pathname);
    }
  }

  for (const route of routeManifest.filter((r) => isIndexableClassification(r.classification))) {
    if (route.pathname === "/") continue;
    const incoming = linkedFrom.get(normalizePathname(route.pathname));
    if (!incoming || incoming.size === 0) {
      critical.push(`orphan indexable page: "${route.pathname}" has no incoming internal links from any other page`);
    }
  }

  return { critical, warnings };
}
