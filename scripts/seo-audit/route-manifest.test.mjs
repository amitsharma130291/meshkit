import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { routeManifest, isIndexableClassification, getRouteEntry, expectedIndexablePathnames } from "./route-manifest.mjs";

const VALID_CLASSIFICATIONS = new Set([
  "indexable-primary",
  "indexable-intent-page",
  "canonical-alias",
  "noindex-utility",
  "development-only",
  "error-page",
]);

describe("route classification", () => {
  it("every entry uses a valid classification", () => {
    for (const route of routeManifest) {
      expect(VALID_CLASSIFICATIONS.has(route.classification), `${route.pathname} has an unknown classification "${route.classification}"`).toBe(true);
    }
  });

  it("every pathname is unique", () => {
    const pathnames = routeManifest.map((r) => r.pathname);
    expect(new Set(pathnames).size).toBe(pathnames.length);
  });

  it("isIndexableClassification agrees with the two indexable variants only", () => {
    expect(isIndexableClassification("indexable-primary")).toBe(true);
    expect(isIndexableClassification("indexable-intent-page")).toBe(true);
    expect(isIndexableClassification("canonical-alias")).toBe(false);
    expect(isIndexableClassification("development-only")).toBe(false);
  });

  it("getRouteEntry finds a known route and returns undefined for an unknown one", () => {
    expect(getRouteEntry("/stl-repair/")?.toolId).toBe("stl-repair");
    expect(getRouteEntry("/does-not-exist/")).toBeUndefined();
  });

  it("development-only routes are excluded from expectedIndexablePathnames", () => {
    expect(expectedIndexablePathnames).not.toContain("/foundation-preview/");
  });

  it("a canonical-alias route declares its redirect target", () => {
    const alias = getRouteEntry("/online-stl-viewer/");
    expect(alias?.redirectsTo).toBe("/stl-viewer/");
  });
});

describe("route manifest completeness against the real repo", () => {
  it("has a manifest entry for every src/pages/*/index.astro directory", () => {
    const pagesDir = path.resolve(process.cwd(), "src/pages");
    const builtDirs = readdirSync(pagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `/${e.name}/`);

    const manifestPathnames = new Set(routeManifest.map((r) => r.pathname));
    for (const dir of builtDirs) {
      expect(manifestPathnames.has(dir), `src/pages${dir} has no route-manifest entry`).toBe(true);
    }
  });

  it("has no manifest entry for a page directory that no longer exists (except the homepage and the redirect alias)", () => {
    const pagesDir = path.resolve(process.cwd(), "src/pages");
    const builtDirs = new Set(
      readdirSync(pagesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `/${e.name}/`),
    );

    for (const route of routeManifest) {
      if (route.pathname === "/" || route.classification === "canonical-alias") continue;
      expect(builtDirs.has(route.pathname), `manifest lists "${route.pathname}" but src/pages has no matching directory`).toBe(true);
    }
  });
});
