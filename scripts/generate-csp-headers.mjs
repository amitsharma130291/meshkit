// Runs automatically after `astro build` (npm's `postbuild` lifecycle hook).
//
// Structured data is emitted as inline `<script type="application/ld+json">`
// blocks (see src/components/seo/StructuredData.astro). Browsers apply
// `script-src` to every <script> element regardless of its `type`, so a
// strict CSP without `'unsafe-inline'` would silently block those blocks.
// Because this is a fully static site (no per-request server to mint a
// nonce), the correct static-hosting-compatible fix is a build-time
// SHA-256 hash allowlist: this script scans the generated dist/**/*.html,
// hashes every JSON-LD block it finds, and appends `'sha256-...'` sources
// to the `script-src` directive already declared in public/_headers
// (copied to dist/_headers by Astro's static asset copy). This keeps the
// CSP strict — only the exact, known-at-build-time JSON-LD content is
// allowed to run as an inline script; nothing else is.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve(process.cwd(), "dist");
const headersFile = path.join(distDir, "_headers");
const JSON_LD_PATTERN = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

async function collectHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectHtmlFiles(full);
      return entry.name.endsWith(".html") ? [full] : [];
    }),
  );
  return files.flat();
}

function sha256Base64(content) {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

async function main() {
  let headers;
  try {
    headers = await readFile(headersFile, "utf8");
  } catch {
    console.warn("[csp] dist/_headers not found; skipping CSP hash injection.");
    return;
  }

  const htmlFiles = await collectHtmlFiles(distDir);
  const hashes = new Set();

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(JSON_LD_PATTERN)) {
      hashes.add(`'sha256-${sha256Base64(match[1])}'`);
    }
  }

  if (hashes.size === 0) {
    console.warn("[csp] No JSON-LD blocks found in dist/**/*.html; script-src left unchanged.");
    return;
  }

  if (!headers.includes("script-src 'self'")) {
    console.warn("[csp] public/_headers doesn't contain the expected `script-src 'self'` baseline; skipping.");
    return;
  }

  const updated = headers.replace("script-src 'self'", `script-src 'self' ${Array.from(hashes).join(" ")}`);
  await writeFile(headersFile, updated, "utf8");
  console.log(`[csp] Added ${hashes.size} JSON-LD script hash(es) to dist/_headers.`);
}

await main();
