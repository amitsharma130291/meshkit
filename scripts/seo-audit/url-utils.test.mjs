import { describe, expect, it } from "vitest";
import { isPlaceholderOrigin, validateAbsoluteUrl, hasConsistentTrailingSlash, normalizePathname } from "./url-utils.mjs";

describe("isPlaceholderOrigin", () => {
  it("rejects example.com", () => {
    expect(isPlaceholderOrigin("https://example.com/stl-viewer/")).toBe(true);
  });
  it("rejects localhost and loopback", () => {
    expect(isPlaceholderOrigin("http://localhost:4321/")).toBe(true);
    expect(isPlaceholderOrigin("http://127.0.0.1/")).toBe(true);
  });
  it("rejects a bare IP host", () => {
    expect(isPlaceholderOrigin("https://192.168.1.1/")).toBe(true);
  });
  it("rejects an invalid URL string outright", () => {
    expect(isPlaceholderOrigin("not-a-url")).toBe(true);
  });
  it("accepts a real-looking production domain", () => {
    expect(isPlaceholderOrigin("https://meshkit.app/stl-viewer/")).toBe(false);
  });
});

describe("validateAbsoluteUrl", () => {
  it("accepts a clean absolute https URL", () => {
    expect(validateAbsoluteUrl("https://meshkit.app/stl-viewer/")).toEqual([]);
  });
  it("flags a non-https URL", () => {
    expect(validateAbsoluteUrl("http://meshkit.app/")).toContain("not https: \"http://meshkit.app/\"");
  });
  it("flags a fragment", () => {
    const issues = validateAbsoluteUrl("https://meshkit.app/stl-viewer/#top");
    expect(issues.some((i) => i.includes("fragment"))).toBe(true);
  });
  it("flags a query/tracking parameter", () => {
    const issues = validateAbsoluteUrl("https://meshkit.app/stl-viewer/?utm_source=x");
    expect(issues.some((i) => i.includes("query"))).toBe(true);
  });
  it("flags a malformed URL", () => {
    expect(validateAbsoluteUrl("/relative/path")).toHaveLength(1);
  });
});

describe("hasConsistentTrailingSlash", () => {
  it("accepts the root path", () => {
    expect(hasConsistentTrailingSlash("/")).toBe(true);
  });
  it("accepts a route ending in a slash", () => {
    expect(hasConsistentTrailingSlash("/stl-viewer/")).toBe(true);
  });
  it("rejects a route missing its trailing slash", () => {
    expect(hasConsistentTrailingSlash("/stl-viewer")).toBe(false);
  });
  it("accepts a file-like endpoint with no trailing slash", () => {
    expect(hasConsistentTrailingSlash("/robots.txt")).toBe(true);
    expect(hasConsistentTrailingSlash("/sitemap-index.xml")).toBe(true);
  });
});

describe("normalizePathname", () => {
  it("strips origin and trailing slash from an absolute URL", () => {
    expect(normalizePathname("https://meshkit.app/stl-viewer/")).toBe("/stl-viewer");
  });
  it("leaves a bare pathname's trailing slash stripped the same way", () => {
    expect(normalizePathname("/stl-viewer/")).toBe("/stl-viewer");
  });
  it("keeps the root path as \"/\"", () => {
    expect(normalizePathname("https://meshkit.app/")).toBe("/");
    expect(normalizePathname("/")).toBe("/");
  });
});
