// Pure, per-page check functions. Each takes a parsed page (from
// html-utils.mjs's parsePage) plus the route's manifest entry and
// returns { critical: string[], warnings: string[] }. Kept side-effect
// free and file-system free so every rule is unit-testable against a
// small inline HTML fixture instead of only against a real build.
import { hasConsistentTrailingSlash, isPlaceholderOrigin, normalizePathname, validateAbsoluteUrl } from "./url-utils.mjs";
import { isIndexableClassification } from "./route-manifest.mjs";

const VAGUE_ANCHOR_TEXT = new Set(["click here", "here", "read more", "learn more", "link", "this page"]);

export function checkTitle(page) {
  const critical = [];
  const warnings = [];
  if (!page.title || page.title.trim().length === 0) {
    critical.push("missing <title>");
  } else {
    const len = page.title.length;
    if (len < 15) warnings.push(`unusually short title (${len} chars): "${page.title}"`);
    if (len > 70) warnings.push(`unusually long title (${len} chars, may be truncated in search results): "${page.title}"`);
  }
  return { critical, warnings };
}

export function checkDescription(page) {
  const critical = [];
  const warnings = [];
  if (!page.description || page.description.trim().length === 0) {
    critical.push("missing meta description");
  } else {
    const len = page.description.length;
    if (len < 50) warnings.push(`unusually short meta description (${len} chars)`);
    if (len > 160) warnings.push(`unusually long meta description (${len} chars, likely truncated in search results)`);
  }
  return { critical, warnings };
}

export function checkHeadings(page) {
  const critical = [];
  const warnings = [];
  if (page.h1s.length === 0) critical.push("missing <h1>");
  if (page.h1s.length > 1) critical.push(`multiple <h1> elements found (${page.h1s.length}): ${page.h1s.join(" | ")}`);
  if (page.mainCount === 0) critical.push("missing <main>");
  if (page.mainCount > 1) warnings.push(`multiple <main> elements found (${page.mainCount})`);
  if (page.navCount === 0) warnings.push("no <nav> landmark found");
  if (page.footerCount === 0) warnings.push("no <footer> landmark found");

  // Heading hierarchy: flag a jump of more than one level (h1 -> h3, etc).
  let previousLevel = 0;
  for (const heading of page.headings) {
    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      warnings.push(`heading level skips from h${previousLevel} to h${heading.level} ("${heading.text}")`);
    }
    previousLevel = heading.level;
  }
  return { critical, warnings };
}

export function checkLangAndViewport(page) {
  const critical = [];
  if (!page.lang || page.lang.trim().length === 0) critical.push("missing <html lang> attribute");
  if (!page.viewport) critical.push("missing <meta name=\"viewport\">");
  return { critical, warnings: [] };
}

export function checkCanonical(page, routeEntry) {
  const critical = [];
  const warnings = [];
  if (!page.canonical) {
    critical.push("missing <link rel=\"canonical\">");
    return { critical, warnings };
  }
  for (const issue of validateAbsoluteUrl(page.canonical)) critical.push(`canonical ${issue}`);
  if (isPlaceholderOrigin(page.canonical)) {
    critical.push(`canonical uses a placeholder/non-production origin: "${page.canonical}"`);
  }
  const expectedPath = routeEntry.redirectsTo ?? routeEntry.pathname;
  const rawCanonicalPath = new URL(page.canonical).pathname;
  const canonicalPath = normalizePathname(page.canonical);
  if (canonicalPath !== normalizePathname(expectedPath)) {
    critical.push(`canonical mismatch: expected path "${expectedPath}", canonical points at "${canonicalPath}"`);
  }
  if (!hasConsistentTrailingSlash(rawCanonicalPath)) {
    warnings.push(`canonical path breaks the trailing-slash policy: "${rawCanonicalPath}"`);
  }
  return { critical, warnings };
}

export function checkRobotsMeta(page, routeEntry) {
  const critical = [];
  const indexable = isIndexableClassification(routeEntry.classification);
  const isNoindex = page.robotsMeta?.includes("noindex") ?? false;
  if (indexable && isNoindex) {
    critical.push(`indexable route unexpectedly has "${page.robotsMeta}" robots meta`);
  }
  if (!indexable && !isNoindex) {
    critical.push(`${routeEntry.classification} route is missing a noindex robots meta tag`);
  }
  return { critical, warnings: [] };
}

export function checkStructuredData(page) {
  const critical = [];
  const warnings = [];
  const seenIds = new Set();

  for (const block of page.jsonLdBlocks) {
    if (block.error) {
      critical.push(`malformed JSON-LD block: ${block.error}`);
      continue;
    }
    const data = block.parsed;
    const type = data["@type"];

    if (data["@id"]) {
      if (seenIds.has(data["@id"])) critical.push(`duplicate JSON-LD @id "${data["@id"]}"`);
      seenIds.add(data["@id"]);
    }

    if (type === "BreadcrumbList") {
      const items = data.itemListElement ?? [];
      if (items.length === 0) critical.push("BreadcrumbList has no itemListElement entries");
      items.forEach((item, index) => {
        if (item.position !== index + 1) critical.push(`BreadcrumbList position out of order at index ${index}`);
        if (!item.item) critical.push(`BreadcrumbList item ${index} is missing a URL`);
        else for (const issue of validateAbsoluteUrl(item.item)) critical.push(`BreadcrumbList item ${index}: ${issue}`);
        if (!item.name) critical.push(`BreadcrumbList item ${index} is missing a name`);
      });
    }

    if (type === "FAQPage") {
      const questions = (data.mainEntity ?? []).map((q) => q.name?.replace(/\s+/g, " ").trim());
      if (questions.length === 0) critical.push("FAQPage has no mainEntity questions");
      for (const q of questions) {
        if (!q || !page.visibleFaqQuestions.includes(q)) {
          critical.push(`FAQPage question not found as visible on-page text: "${q}"`);
        }
      }
      for (const q of data.mainEntity ?? []) {
        if (!q.acceptedAnswer?.text || q.acceptedAnswer.text.trim().length === 0) {
          critical.push(`FAQPage question "${q.name}" has an empty answer`);
        }
      }
    }

    if (type === "WebApplication") {
      if (!data.name) critical.push("WebApplication is missing name");
      for (const offer of data.offers ?? []) {
        if (offer.price === undefined || offer.price === null || offer.price === "") {
          critical.push("WebApplication offer is missing a price");
          continue;
        }
        // Step 0 stabilization (Phase 8 readiness-audit fix): this product has
        // no checkout, no license product and no payment implementation
        // anywhere — a priced Offer with no real purchase capability behind
        // it is misleading structured data, independent of how honestly the
        // visible page copy is hedged ("planned"). A genuine $0 offer is
        // fine; anything else needs `availability: PreOrder` (schema.org's
        // own "not yet purchasable" vocabulary) or should not exist yet.
        const price = Number(offer.price);
        const isFree = Number.isFinite(price) && price === 0;
        const isDisclosedPreorder = offer.availability === "https://schema.org/PreOrder";
        if (!isFree && !isDisclosedPreorder) {
          critical.push(
            `WebApplication has a purchasable-looking Offer (price "${offer.price}") with no real purchase capability behind it — remove it or mark it "https://schema.org/PreOrder" only if a real preorder flow exists`,
          );
        }
      }
    }

    // Generic empty/undefined property scan (one level deep).
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === "") {
        critical.push(`JSON-LD "${type}" has an empty/undefined property "${key}"`);
      }
    }
  }
  return { critical, warnings };
}

export function checkOpenGraph(page, existsFn) {
  const critical = [];
  const warnings = [];
  const required = ["og:title", "og:description", "og:url", "og:type", "og:image"];
  for (const prop of required) {
    if (!page.og[prop]) critical.push(`missing Open Graph property "${prop}"`);
  }
  if (page.og["og:image"]) {
    for (const issue of validateAbsoluteUrl(page.og["og:image"])) critical.push(`og:image ${issue}`);
    if (isPlaceholderOrigin(page.og["og:image"])) critical.push(`og:image uses a placeholder origin: "${page.og["og:image"]}"`);
    if (existsFn && !existsFn(page.og["og:image"])) {
      critical.push(`og:image asset does not exist in dist/: "${page.og["og:image"]}"`);
    }
  }
  if (!page.og["og:image:alt"]) warnings.push("og:image has no alt text (og:image:alt)");
  if (!page.twitter["twitter:card"]) warnings.push("missing twitter:card");
  return { critical, warnings };
}

export function checkImages(page) {
  const warnings = [];
  for (const img of page.images) {
    if (img.alt === null) warnings.push(`<img src="${img.src}"> has no alt attribute`);
    if (!img.width || !img.height) warnings.push(`<img src="${img.src}"> is missing explicit width/height (layout-shift risk)`);
  }
  return { critical: [], warnings };
}

export function checkFileInputLabels(page) {
  const critical = [];
  for (const input of page.fileInputs) {
    if (!input.ariaLabel && !input.hasAssociatedLabel) {
      critical.push(`file input "${input.id ?? "(no id)"}" has no accessible label (aria-label or <label for>)`);
    }
  }
  return { critical, warnings: [] };
}

export function checkAnchorText(page) {
  const warnings = [];
  for (const link of page.links) {
    const normalized = link.text.toLowerCase().trim();
    if (VAGUE_ANCHOR_TEXT.has(normalized)) {
      warnings.push(`vague anchor text "${link.text}" for link to "${link.href}"`);
    }
  }
  return { critical: [], warnings };
}
