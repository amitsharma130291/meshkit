import { describe, expect, it } from "vitest";
import { checkUniqueness, checkSitemap, checkRobotsTxt, checkLinkGraph } from "./sitewide-checks.mjs";

function makePage(overrides = {}) {
  return { title: null, description: null, links: [], ...overrides };
}

describe("checkUniqueness", () => {
  it("fails on two pages sharing an exact title", () => {
    const pages = new Map([
      ["/a/", makePage({ title: "Same Title" })],
      ["/b/", makePage({ title: "Same Title" })],
    ]);
    const result = checkUniqueness(pages);
    expect(result.critical.some((c) => c.includes("duplicate <title>"))).toBe(true);
  });

  it("fails on two pages sharing an exact description", () => {
    const pages = new Map([
      ["/a/", makePage({ title: "A", description: "Same description text." })],
      ["/b/", makePage({ title: "B", description: "Same description text." })],
    ]);
    expect(checkUniqueness(pages).critical.some((c) => c.includes("duplicate meta description"))).toBe(true);
  });

  it("passes distinct titles and descriptions", () => {
    const pages = new Map([
      ["/a/", makePage({ title: "A", description: "Description A." })],
      ["/b/", makePage({ title: "B", description: "Description B." })],
    ]);
    const result = checkUniqueness(pages);
    expect(result.critical).toEqual([]);
  });

  it("warns (not fails) on descriptions with an identical opening but different endings", () => {
    const pages = new Map([
      ["/a/", makePage({ title: "A", description: "Repair an STL file's holes and non-manifold edges for printing today." })],
      ["/b/", makePage({ title: "B", description: "Repair an STL file's holes and non-manifold edges before slicing tonight." })],
    ]);
    const result = checkUniqueness(pages);
    expect(result.critical).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

const manifest = [
  { pathname: "/", classification: "indexable-primary" },
  { pathname: "/stl-viewer/", classification: "indexable-primary" },
  { pathname: "/foundation-preview/", classification: "development-only" },
];

describe("checkSitemap", () => {
  it("fails when an indexable route is missing from the sitemap", () => {
    const result = checkSitemap(["https://meshkit.app/"], manifest);
    expect(result.critical.some((c) => c.includes("missing from sitemap"))).toBe(true);
  });

  it("fails when a development-only route appears in the sitemap", () => {
    const urls = ["https://meshkit.app/", "https://meshkit.app/stl-viewer/", "https://meshkit.app/foundation-preview/"];
    const result = checkSitemap(urls, manifest);
    expect(result.critical.some((c) => c.includes("unexpectedly appears"))).toBe(true);
  });

  it("fails on a duplicate <loc> entry", () => {
    const urls = ["https://meshkit.app/", "https://meshkit.app/", "https://meshkit.app/stl-viewer/"];
    const result = checkSitemap(urls, manifest);
    expect(result.critical.some((c) => c.includes("duplicate <loc>"))).toBe(true);
  });

  it("passes a sitemap that exactly matches the indexable set", () => {
    const urls = ["https://meshkit.app/", "https://meshkit.app/stl-viewer/"];
    const result = checkSitemap(urls, manifest);
    expect(result.critical).toEqual([]);
  });
});

describe("checkRobotsTxt", () => {
  it("fails on a site-wide disallow", () => {
    const result = checkRobotsTxt("User-agent: *\nDisallow: /\n\nSitemap: https://meshkit.app/sitemap-index.xml", manifest);
    expect(result.critical.some((c) => c.includes("disallows the entire site"))).toBe(true);
  });

  it("fails when there is no Sitemap: line", () => {
    const result = checkRobotsTxt("User-agent: *\nAllow: /", manifest);
    expect(result.critical.some((c) => c.includes("no Sitemap:"))).toBe(true);
  });

  it("warns when a development-only route isn't blocked", () => {
    const result = checkRobotsTxt("User-agent: *\nAllow: /\n\nSitemap: https://meshkit.app/sitemap-index.xml", manifest);
    expect(result.warnings.some((w) => w.includes("foundation-preview"))).toBe(true);
  });

  it("passes valid syntax with the dev route disallowed", () => {
    const result = checkRobotsTxt(
      "User-agent: *\nAllow: /\nDisallow: /foundation-preview/\n\nSitemap: https://meshkit.app/sitemap-index.xml",
      manifest,
    );
    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkLinkGraph", () => {
  it("fails on a broken internal link to a non-existent route", () => {
    const pages = new Map([
      ["/", makePage({ links: [{ href: "/does-not-exist/", text: "Go" }] })],
      ["/stl-viewer/", makePage({ links: [] })],
    ]);
    const result = checkLinkGraph(pages, manifest);
    expect(result.critical.some((c) => c.includes("broken internal link"))).toBe(true);
  });

  it("fails on an orphan indexable page with no incoming links", () => {
    const pages = new Map([
      ["/", makePage({ links: [] })],
      ["/stl-viewer/", makePage({ links: [] })],
    ]);
    const result = checkLinkGraph(pages, manifest);
    expect(result.critical.some((c) => c.includes("orphan indexable page"))).toBe(true);
  });

  it("passes when every indexable page is linked from somewhere and every link resolves", () => {
    const pages = new Map([
      ["/", makePage({ links: [{ href: "/stl-viewer/", text: "Open STL Viewer" }] })],
      ["/stl-viewer/", makePage({ links: [{ href: "/", text: "Home" }] })],
    ]);
    const result = checkLinkGraph(pages, manifest);
    expect(result.critical).toEqual([]);
  });

  it("resolves a link to a redirect-alias route without flagging it broken", () => {
    const aliasManifest = [...manifest, { pathname: "/online-stl-viewer/", classification: "canonical-alias", redirectsTo: "/stl-viewer/" }];
    const pages = new Map([
      ["/", makePage({ links: [{ href: "/stl-viewer/", text: "Open" }, { href: "/online-stl-viewer/", text: "Alias" }] })],
      ["/stl-viewer/", makePage({ links: [] })],
    ]);
    const result = checkLinkGraph(pages, aliasManifest);
    expect(result.critical.filter((c) => c.includes("broken"))).toEqual([]);
  });

  it("ignores external, mailto, tel and fragment-only links", () => {
    const pages = new Map([
      [
        "/",
        makePage({
          links: [
            { href: "https://external.example/", text: "External" },
            { href: "mailto:hi@meshkit.app", text: "Email" },
            { href: "#top", text: "Top" },
            { href: "/stl-viewer/", text: "Open STL Viewer" },
          ],
        }),
      ],
      ["/stl-viewer/", makePage({ links: [] })],
    ]);
    const result = checkLinkGraph(pages, manifest);
    expect(result.critical.filter((c) => c.includes("broken"))).toEqual([]);
  });
});
