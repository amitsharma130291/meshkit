/**
 * Proves the production entitlement path can't be bypassed and that
 * server-only secrets can't leak into the browser bundle, by inspecting
 * SOURCE (this test runs pre-build) for the forbidden patterns below.
 * Phase 11 legitimately introduces a real unlock path (a Dodo-issued
 * license key, always re-verified server-side — see
 * `production-provider.ts` and `production-provider.test.ts`'s own
 * source-level guarantee that "pro" is never resolved synchronously) —
 * what this file guards is narrower than Phase 10's "nothing payment-
 * related exists at all": no CLIENT-SIDE-ONLY bypass, and no server
 * secret (`src/lib/server/*`, which holds the Dodo API key, webhook
 * key, Gmail app password and Redis token) ever gets imported from
 * browser-executed code.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PRO_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC_DIR = join(PRO_DIR, "..", "..");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(fileName: string): string {
  return stripComments(readFileSync(join(PRO_DIR, fileName), "utf8"));
}

function collectFiles(dir: string, matcher: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, matcher, out);
    else if (matcher(entry.name)) out.push(full);
  }
  return out;
}

describe("production-provider.ts never imports test-provider.ts", () => {
  it("has no import/require reference to the test provider module", () => {
    const source = readSource("production-provider.ts");
    expect(source).not.toMatch(/test-provider/);
  });
});

describe("no production page source imports test-provider.ts directly", () => {
  it("scans every _client.ts under src/pages for a test-provider import", () => {
    const pagesDir = join(SRC_DIR, "pages");
    const offenders: string[] = [];
    for (const file of collectFiles(pagesDir, (name) => name.endsWith("_client.ts"))) {
      if (/test-provider/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("no query-string, hash, or devPro entitlement unlock exists anywhere in src/", () => {
  const forbidden = ["location.search", "URLSearchParams", "location.hash", "devPro"];

  it.each(forbidden)("production-provider.ts never references %s", (token) => {
    expect(readSource("production-provider.ts")).not.toContain(token);
  });

  it("no source file references devPro (a query-string-driven entitlement unlock)", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(SRC_DIR, (name) => /\.(ts|astro)$/.test(name) && !name.endsWith(".test.ts"))) {
      if (/devPro/i.test(stripComments(readFileSync(file, "utf8")))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("server-only secrets (src/lib/server/*) never reach browser-executed code", () => {
  it("no _client.ts under src/pages imports anything from src/lib/server", () => {
    const pagesDir = join(SRC_DIR, "pages");
    const offenders: string[] = [];
    for (const file of collectFiles(pagesDir, (name) => name.endsWith("_client.ts"))) {
      if (/lib\/server/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no _client.ts under src/pages talks to the Dodo Payments API directly — every call goes through our own /api/* routes", () => {
    const pagesDir = join(SRC_DIR, "pages");
    const offenders: string[] = [];
    for (const file of collectFiles(pagesDir, (name) => name.endsWith("_client.ts"))) {
      if (/dodopayments\.com/i.test(stripComments(readFileSync(file, "utf8")))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no component (.astro) file's inline <script> references src/lib/server — those imports would bundle into the browser", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(SRC_DIR, (name) => name.endsWith(".astro"))) {
      const source = readFileSync(file, "utf8");
      const scriptBlocks = source.match(/<script(?![^>]*\bis:inline\b)[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      for (const block of scriptBlocks) {
        if (/lib\/server/.test(block)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every server route that reads a Dodo/Gmail/Redis secret does so via src/lib/server/env.ts, never a hardcoded literal", () => {
  it("no source file (outside env.ts itself) contains a Dodo-looking bearer-token literal assignment", () => {
    const offenders: string[] = [];
    // A crude but effective smell test: a long quoted string assigned
    // directly to something named like an API key/secret, rather than
    // read from import.meta.env via env.ts's accessors.
    const suspicious = /(DODO_PAYMENTS_API_KEY|DODO_PAYMENTS_WEBHOOK_KEY|GMAIL_SMTP_APP_PASSWORD|KV_REST_API_TOKEN)\s*[:=]\s*["'`][^"'`]{8,}["'`]/;
    for (const file of collectFiles(SRC_DIR, (name) => /\.(ts|astro)$/.test(name) && !name.endsWith(".test.ts"))) {
      if (suspicious.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
