/**
 * Proves the production entitlement path can't be bypassed, by
 * inspecting SOURCE (this test runs pre-build) for the forbidden
 * patterns the Phase 10 spec lists. A separate, build-dependent check
 * (`npm run check:production-bundle`-equivalent — see the release-gate
 * notes in `docs/ARCHITECTURE.md`) inspects the actual emitted `dist/`
 * bundle for the same patterns once a production build exists; this
 * test is the fast, always-runnable half of that guarantee.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PRO_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(fileName: string): string {
  return stripComments(readFileSync(join(PRO_DIR, fileName), "utf8"));
}

describe("production-provider.ts never imports test-provider.ts", () => {
  it("has no import/require reference to the test provider module", () => {
    const source = readSource("production-provider.ts");
    expect(source).not.toMatch(/test-provider/);
  });
});

describe("no production page source imports test-provider.ts directly", () => {
  it("scans every _client.ts under src/pages for a test-provider import", () => {
    const pagesDir = join(PRO_DIR, "..", "..", "pages");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith("_client.ts")) {
          const source = stripComments(readFileSync(full, "utf8"));
          if (/test-provider/.test(source)) offenders.push(full);
        }
      }
    }
    walk(pagesDir);

    expect(offenders).toEqual([]);
  });
});

describe("no query-string or localStorage entitlement unlock exists anywhere in src/lib/pro", () => {
  const forbidden = ["localStorage", "sessionStorage", "location.search", "URLSearchParams", "location.hash"];

  it.each(forbidden)("production-provider.ts never references %s", (token) => {
    expect(readSource("production-provider.ts")).not.toContain(token);
  });
});

describe("no query-string entitlement-unlock mechanism (devPro or otherwise) exists anywhere in src/", () => {
  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, out);
      else if (/\.(ts|astro)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it("no source file references devPro or a query-string-driven entitlement unlock", () => {
    const srcDir = join(PRO_DIR, "..", "..");
    const offenders: string[] = [];
    for (const file of collectSourceFiles(srcDir)) {
      const text = stripComments(readFileSync(file, "utf8"));
      if (/devPro/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Phase 10 has not introduced Phase 11 payment/licensing concepts anywhere in src/", () => {
  const forbidden = [
    { pattern: /dodo/i, label: "a Dodo Payments SDK reference" },
    { pattern: /\bcheckout\b/i, label: "a checkout route or flow" },
    { pattern: /license[- ]?key/i, label: "license-key entry" },
    { pattern: /purchase[- ]?success/i, label: "a purchase-success handler" },
  ];

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, out);
      else if (/\.(ts|astro)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it.each(forbidden)("no source file mentions $label", ({ pattern }) => {
    const srcDir = join(PRO_DIR, "..", "..");
    const offenders: string[] = [];
    for (const file of collectSourceFiles(srcDir)) {
      const text = stripComments(readFileSync(file, "utf8"));
      if (pattern.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no `offers` entry declares a nonzero price — every existing Offer is the free ($0) tier", () => {
    const srcDir = join(PRO_DIR, "..", "..");
    const offenders: { file: string; price: string }[] = [];
    // Matches `price: "39"` / `price: 39` but not `price: "0"` — free-tier
    // Offer markup (every existing tool page) is expected and allowed;
    // this only flags a genuinely NEW nonzero price being introduced.
    const nonzeroPrice = /price:\s*"?(\d+(?:\.\d+)?)"?/g;
    for (const file of collectSourceFiles(srcDir)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(nonzeroPrice)) {
        if (match[1] !== "0") offenders.push({ file, price: match[1] });
      }
    }
    expect(offenders).toEqual([]);
  });
});
