import { describe, expect, it } from "vitest";
import { parsePage } from "./html-utils.mjs";
import {
  checkTitle,
  checkDescription,
  checkHeadings,
  checkLangAndViewport,
  checkCanonical,
  checkRobotsMeta,
  checkStructuredData,
  checkOpenGraph,
  checkFileInputLabels,
  checkAnchorText,
} from "./checks.mjs";

function page(bodyHtml, headHtml = "") {
  return parsePage(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width">${headHtml}</head><body>${bodyHtml}</body></html>`);
}

const indexableRoute = { pathname: "/stl-viewer/", classification: "indexable-primary" };
const devRoute = { pathname: "/foundation-preview/", classification: "development-only" };

describe("checkTitle", () => {
  it("fails on a missing title", () => {
    const result = checkTitle(page("<h1>x</h1>"));
    expect(result.critical).toContain("missing <title>");
  });
  it("warns on a very short title", () => {
    const result = checkTitle(page("<h1>x</h1>", "<title>Hi</title>"));
    expect(result.warnings.some((w) => w.includes("short"))).toBe(true);
  });
  it("passes a reasonable title with no issues", () => {
    const result = checkTitle(page("<h1>x</h1>", "<title>STL Viewer — Inspect 3D Models Online | MeshWrench</title>"));
    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkDescription", () => {
  it("fails on a missing description", () => {
    expect(checkDescription(page("<h1>x</h1>")).critical).toContain("missing meta description");
  });
  it("warns on an overly long description", () => {
    const long = "x".repeat(200);
    const result = checkDescription(page("<h1>x</h1>", `<meta name="description" content="${long}">`));
    expect(result.warnings.some((w) => w.includes("long"))).toBe(true);
  });
});

describe("checkHeadings", () => {
  it("fails when there is no h1", () => {
    expect(checkHeadings(page("<main><h2>x</h2></main>")).critical).toContain("missing <h1>");
  });
  it("fails on multiple h1s", () => {
    const result = checkHeadings(page("<main><h1>A</h1><h1>B</h1></main>"));
    expect(result.critical.some((c) => c.includes("multiple <h1>"))).toBe(true);
  });
  it("fails when there is no <main>", () => {
    expect(checkHeadings(page("<h1>x</h1>")).critical).toContain("missing <main>");
  });
  it("warns on a heading level skip from h1 to h3", () => {
    const result = checkHeadings(page("<main><h1>A</h1><h3>B</h3></main>"));
    expect(result.warnings.some((w) => w.includes("skips from h1 to h3"))).toBe(true);
  });
  it("passes a clean, single-h1-with-main, no-skip page", () => {
    const result = checkHeadings(page("<nav></nav><main><h1>A</h1><h2>B</h2></main><footer></footer>"));
    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkLangAndViewport", () => {
  it("fails when <html> has no lang attribute", () => {
    const parsed = parsePage(`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`);
    expect(checkLangAndViewport(parsed).critical).toContain("missing <html lang> attribute");
  });
  it("fails when the viewport meta tag is missing", () => {
    const parsed = parsePage(`<!doctype html><html lang="en"><head></head><body></body></html>`);
    expect(checkLangAndViewport(parsed).critical).toContain('missing <meta name="viewport">');
  });
});

describe("checkCanonical", () => {
  it("fails when canonical is missing", () => {
    expect(checkCanonical(page("<h1>x</h1>"), indexableRoute).critical).toContain('missing <link rel="canonical">');
  });
  it("fails on a placeholder-origin canonical", () => {
    const result = checkCanonical(page("<h1>x</h1>", '<link rel="canonical" href="https://example.com/stl-viewer/">'), indexableRoute);
    expect(result.critical.some((c) => c.includes("placeholder"))).toBe(true);
  });
  it("fails on a canonical that points at the wrong route", () => {
    const result = checkCanonical(page("<h1>x</h1>", '<link rel="canonical" href="https://meshkit.app/wrong-route/">'), indexableRoute);
    expect(result.critical.some((c) => c.includes("mismatch"))).toBe(true);
  });
  it("warns when the canonical is missing its trailing slash", () => {
    const result = checkCanonical(page("<h1>x</h1>", '<link rel="canonical" href="https://meshkit.app/stl-viewer">'), { pathname: "/stl-viewer", classification: "indexable-primary" });
    expect(result.warnings.some((w) => w.includes("trailing-slash"))).toBe(true);
  });
  it("passes a correct, real-domain canonical with no issues", () => {
    const result = checkCanonical(page("<h1>x</h1>", '<link rel="canonical" href="https://meshkit.app/stl-viewer/">'), indexableRoute);
    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
  it("resolves a redirect-alias route against its redirectsTo target", () => {
    const aliasRoute = { pathname: "/online-stl-viewer/", classification: "canonical-alias", redirectsTo: "/stl-viewer/" };
    const result = checkCanonical(page("<h1>x</h1>", '<link rel="canonical" href="https://meshkit.app/stl-viewer/">'), aliasRoute);
    expect(result.critical).toEqual([]);
  });
});

describe("checkRobotsMeta", () => {
  it("fails when an indexable route has noindex", () => {
    const result = checkRobotsMeta(page("<h1>x</h1>", '<meta name="robots" content="noindex, nofollow">'), indexableRoute);
    expect(result.critical.some((c) => c.includes("unexpectedly has"))).toBe(true);
  });
  it("fails when a development-only route is missing noindex", () => {
    const result = checkRobotsMeta(page("<h1>x</h1>", '<meta name="robots" content="index, follow">'), devRoute);
    expect(result.critical.some((c) => c.includes("missing a noindex"))).toBe(true);
  });
  it("passes an indexable route with index,follow", () => {
    const result = checkRobotsMeta(page("<h1>x</h1>", '<meta name="robots" content="index, follow">'), indexableRoute);
    expect(result.critical).toEqual([]);
  });
});

describe("checkStructuredData", () => {
  it("fails on malformed JSON-LD", () => {
    const result = checkStructuredData(page("<h1>x</h1>", '<script type="application/ld+json">{not json}</script>'));
    expect(result.critical.some((c) => c.includes("malformed"))).toBe(true);
  });

  it("fails when a FAQPage question is not visible on the page", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes." } }],
    });
    const result = checkStructuredData(page(`<h1>x</h1><details><summary>Some other question</summary></details>`, `<script type="application/ld+json">${jsonLd}</script>`));
    expect(result.critical.some((c) => c.includes("not found as visible"))).toBe(true);
  });

  it("passes when the FAQPage question matches visible text exactly", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes." } }],
    });
    const result = checkStructuredData(page(`<h1>x</h1><details><summary>Is it free?</summary></details>`, `<script type="application/ld+json">${jsonLd}</script>`));
    expect(result.critical).toEqual([]);
  });

  it("fails a BreadcrumbList with out-of-order positions", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 2, name: "Home", item: "https://meshkit.app/" },
        { "@type": "ListItem", position: 1, name: "STL Viewer", item: "https://meshkit.app/stl-viewer/" },
      ],
    });
    const result = checkStructuredData(page("<h1>x</h1>", `<script type="application/ld+json">${jsonLd}</script>`));
    expect(result.critical.some((c) => c.includes("out of order"))).toBe(true);
  });

  it("fails a WebApplication offer with a non-zero price and no real purchase capability (Step 0 stabilization: no product on this site can actually be bought today)", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "MeshWrench",
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any modern web browser",
      offers: [
        { "@type": "Offer", price: "0", priceCurrency: "USD", category: "Free browser tools" },
        { "@type": "Offer", price: "39", priceCurrency: "USD", category: "Lifetime Pro license" },
      ],
    });
    const result = checkStructuredData(page("<h1>x</h1>", `<script type="application/ld+json">${jsonLd}</script>`));
    expect(result.critical.some((c) => c.includes("purchasable") || c.includes("Offer"))).toBe(true);
  });

  it("passes a WebApplication with only a free ($0) offer", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "MeshWrench",
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any modern web browser",
      offers: [{ "@type": "Offer", price: "0", priceCurrency: "USD", category: "Free browser tools" }],
    });
    const result = checkStructuredData(page("<h1>x</h1>", `<script type="application/ld+json">${jsonLd}</script>`));
    expect(result.critical).toEqual([]);
  });
});

describe("checkOpenGraph", () => {
  it("fails when required OG properties are missing", () => {
    const result = checkOpenGraph(page("<h1>x</h1>"));
    expect(result.critical.length).toBeGreaterThan(0);
  });
  it("fails when og:image asset does not exist on disk", () => {
    const html = page(
      "<h1>x</h1>",
      '<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:url" content="https://meshkit.app/"><meta property="og:type" content="website"><meta property="og:image" content="https://meshkit.app/missing.png">',
    );
    const result = checkOpenGraph(html, () => false);
    expect(result.critical.some((c) => c.includes("does not exist"))).toBe(true);
  });
  it("passes when every required property is present and the asset exists", () => {
    const html = page(
      "<h1>x</h1>",
      '<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:url" content="https://meshkit.app/"><meta property="og:type" content="website"><meta property="og:image" content="https://meshkit.app/mesh-hero.png"><meta property="og:image:alt" content="alt text"><meta name="twitter:card" content="summary_large_image">',
    );
    const result = checkOpenGraph(html, () => true);
    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkFileInputLabels", () => {
  it("fails on a file input with no accessible label", () => {
    const result = checkFileInputLabels(page('<input type="file" id="f">'));
    expect(result.critical.length).toBe(1);
  });
  it("passes a file input with an aria-label", () => {
    const result = checkFileInputLabels(page('<input type="file" id="f" aria-label="Select a file">'));
    expect(result.critical).toEqual([]);
  });
  it("passes a file input with an associated <label for>", () => {
    const result = checkFileInputLabels(page('<label for="f">Select a file</label><input type="file" id="f">'));
    expect(result.critical).toEqual([]);
  });
});

describe("checkAnchorText", () => {
  it("warns on vague anchor text like \"click here\"", () => {
    const result = checkAnchorText(page('<a href="/stl-viewer/">Click here</a>'));
    expect(result.warnings.length).toBe(1);
  });
  it("passes descriptive anchor text", () => {
    const result = checkAnchorText(page('<a href="/stl-viewer/">Open STL Viewer</a>'));
    expect(result.warnings).toEqual([]);
  });
});
