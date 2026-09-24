// Phase 7 SEO audit — inspects the FINAL STATIC dist/ OUTPUT (never just
// Astro source props), because that's the only thing a crawler ever sees.
// Run after `npm run build` (see the "seo:audit" package.json script,
// which always builds first). Writes a machine-readable summary to
// dist/seo-audit.json and exits non-zero on any critical violation.
//
// See docs/SEO-LAUNCH-CHECKLIST.md for what every check means and why,
// and docs/SEO-PAGE-INVENTORY.md for the per-route classification table
// this script's own route-manifest.mjs mirrors.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parsePage } from "./seo-audit/html-utils.mjs";
import { routeManifest } from "./seo-audit/route-manifest.mjs";
import { isPlaceholderOrigin, normalizePathname } from "./seo-audit/url-utils.mjs";
import {
  checkTitle,
  checkDescription,
  checkHeadings,
  checkLangAndViewport,
  checkCanonical,
  checkRobotsMeta,
  checkStructuredData,
  checkOpenGraph,
  checkImages,
  checkFileInputLabels,
  checkAnchorText,
} from "./seo-audit/checks.mjs";
import { checkUniqueness, checkSitemap, checkRobotsTxt, checkLinkGraph } from "./seo-audit/sitewide-checks.mjs";
import { scanForStaleClaims } from "./seo-audit/content-accuracy.mjs";
import { resolveProductionSiteUrl } from "./seo-audit/site-url-resolver.mjs";
import { resolveDistDir } from "./dist-dir.mjs";

const distDir = resolveDistDir();

function htmlFileForPathname(pathname) {
  if (pathname === "/") return path.join(distDir, "index.html");
  return path.join(distDir, pathname.replace(/^\//, ""), "index.html");
}

function distAssetExists(absoluteOrRelativeUrl) {
  try {
    const url = new URL(absoluteOrRelativeUrl, "https://placeholder.invalid");
    const assetPath = path.join(distDir, decodeURIComponent(url.pathname));
    return existsSync(assetPath);
  } catch {
    return false;
  }
}

function collectSitemapUrls() {
  const indexPath = path.join(distDir, "sitemap-index.xml");
  if (!existsSync(indexPath)) return { urls: [], sitemapFiles: [] };

  const indexXml = readFileSync(indexPath, "utf8");
  const sitemapFiles = [...indexXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

  const urls = [];
  for (const sitemapUrl of sitemapFiles) {
    const filename = new URL(sitemapUrl).pathname.split("/").pop();
    const filePath = path.join(distDir, filename);
    if (!existsSync(filePath)) continue;
    const xml = readFileSync(filePath, "utf8");
    for (const m of xml.matchAll(/<loc>(.*?)<\/loc>/g)) urls.push(m[1]);
  }
  return { urls, sitemapFiles };
}

function main() {
  if (!existsSync(distDir)) {
    console.error("[seo-audit] dist/ not found — run `npm run build` first.");
    process.exit(1);
  }

  const siteUrl = resolveProductionSiteUrl();
  const criticalIssues = [];
  const warningIssues = [];
  const routeReports = [];
  const pagesByPathname = new Map();

  if (!siteUrl) {
    criticalIssues.push({ scope: "config", message: "astro.config.mjs has no `site` value set" });
  } else if (isPlaceholderOrigin(siteUrl)) {
    criticalIssues.push({
      scope: "config",
      message: `LAUNCH BLOCKER: production origin is still a placeholder ("${siteUrl}"). Every canonical, sitemap and Open Graph URL is built from this value. Set a real domain in src/config/site.ts (siteUrl) and astro.config.mjs (site) together before publishing — see docs/SEO-LAUNCH-CHECKLIST.md.`,
    });
  }

  // --- Per-page checks -----------------------------------------------
  for (const route of routeManifest) {
    if (route.classification === "canonical-alias") continue; // no page of its own to parse

    const filePath = htmlFileForPathname(route.pathname);
    if (!existsSync(filePath)) {
      criticalIssues.push({ scope: route.pathname, message: `expected built route not found: ${filePath}` });
      continue;
    }

    const html = readFileSync(filePath, "utf8");
    const page = parsePage(html);
    pagesByPathname.set(route.pathname, page);

    const results = [
      checkTitle(page),
      checkDescription(page),
      checkHeadings(page),
      checkLangAndViewport(page),
      checkCanonical(page, route),
      checkRobotsMeta(page, route),
      checkStructuredData(page),
      checkOpenGraph(page, distAssetExists),
      checkImages(page),
      checkFileInputLabels(page),
      checkAnchorText(page),
    ];

    const routeCritical = [];
    const routeWarnings = [];
    for (const r of results) {
      routeCritical.push(...r.critical);
      routeWarnings.push(...r.warnings);
    }

    // Canonical must resolve to a route that actually exists in dist/.
    if (page.canonical) {
      const canonicalPath = normalizePathname(page.canonical);
      const canonicalFile = htmlFileForPathname(canonicalPath === "/" ? "/" : canonicalPath + "/");
      if (!existsSync(canonicalFile)) {
        routeCritical.push(`canonical URL does not resolve to a real built route: "${page.canonical}"`);
      }
    }

    for (const finding of scanForStaleClaims(page.bodyText)) {
      routeCritical.push(`stale/unsupported claim (${finding.reason}): "${finding.match}"`);
    }

    for (const m of routeCritical) criticalIssues.push({ scope: route.pathname, message: m });
    for (const m of routeWarnings) warningIssues.push({ scope: route.pathname, message: m });

    routeReports.push({
      pathname: route.pathname,
      classification: route.classification,
      toolId: route.toolId,
      title: page.title,
      description: page.description,
      canonical: page.canonical,
      h1: page.h1s[0] ?? null,
      structuredDataTypes: page.jsonLdBlocks.filter((b) => b.parsed).map((b) => b.parsed["@type"]),
      ogImage: page.og["og:image"] ?? null,
      criticalCount: routeCritical.length,
      warningCount: routeWarnings.length,
    });
  }

  // --- Sitewide checks -------------------------------------------------
  const uniqueness = checkUniqueness(pagesByPathname);
  criticalIssues.push(...uniqueness.critical.map((m) => ({ scope: "sitewide", message: m })));
  warningIssues.push(...uniqueness.warnings.map((m) => ({ scope: "sitewide", message: m })));

  const { urls: sitemapUrls } = collectSitemapUrls();
  if (sitemapUrls.length === 0) {
    criticalIssues.push({ scope: "sitemap", message: "no sitemap URLs found (sitemap-index.xml missing or empty)" });
  } else {
    const sitemapResult = checkSitemap(sitemapUrls, routeManifest);
    criticalIssues.push(...sitemapResult.critical.map((m) => ({ scope: "sitemap", message: m })));
    warningIssues.push(...sitemapResult.warnings.map((m) => ({ scope: "sitemap", message: m })));
  }

  const robotsPath = path.join(distDir, "robots.txt");
  if (!existsSync(robotsPath)) {
    criticalIssues.push({ scope: "robots.txt", message: "dist/robots.txt not found" });
  } else {
    const robotsTxt = readFileSync(robotsPath, "utf8");
    const robotsResult = checkRobotsTxt(robotsTxt, routeManifest);
    criticalIssues.push(...robotsResult.critical.map((m) => ({ scope: "robots.txt", message: m })));
    warningIssues.push(...robotsResult.warnings.map((m) => ({ scope: "robots.txt", message: m })));
  }

  const linkGraph = checkLinkGraph(pagesByPathname, routeManifest);
  criticalIssues.push(...linkGraph.critical.map((m) => ({ scope: "link-graph", message: m })));
  warningIssues.push(...linkGraph.warnings.map((m) => ({ scope: "link-graph", message: m })));

  // --- Report ------------------------------------------------------
  const report = {
    siteUrl,
    routesAudited: routeReports.length,
    criticalCount: criticalIssues.length,
    warningCount: warningIssues.length,
    critical: criticalIssues,
    warnings: warningIssues,
    routes: routeReports,
  };
  writeFileSync(path.join(distDir, "seo-audit.json"), JSON.stringify(report, null, 2));

  console.log(`\n[seo-audit] Audited ${routeReports.length} routes.`);
  console.log(`[seo-audit] ${criticalIssues.length} critical issue(s), ${warningIssues.length} warning(s).\n`);

  if (criticalIssues.length > 0) {
    console.log("CRITICAL:");
    for (const issue of criticalIssues) console.log(`  [${issue.scope}] ${issue.message}`);
  }
  if (warningIssues.length > 0) {
    console.log("\nWARNINGS:");
    for (const issue of warningIssues) console.log(`  [${issue.scope}] ${issue.message}`);
  }
  console.log(`\n[seo-audit] Full report written to dist/seo-audit.json`);

  if (criticalIssues.length > 0) {
    process.exit(1);
  }
}

main();
