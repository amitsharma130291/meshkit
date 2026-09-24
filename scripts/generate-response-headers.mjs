// Runs as the second half of `npm run build` (package.json chains this
// script directly onto `astro build`, deliberately NOT as a separate npm
// "postbuild" lifecycle-hook script — that way it always runs regardless
// of exactly how a host invokes the build, rather than depending on the
// host running the build via `npm run build` specifically, which is what
// makes npm's implicit postbuild-name convention fire). Was
// `generate-csp-headers.mjs` — renamed and extended in Phase 11 when
// Vercel deployment was added, since Vercel doesn't read the Netlify/
// Cloudflare Pages `_headers`/`_redirects` convention at all; it needs
// its own Build Output API config.
//
// Structured data is emitted as inline `<script type="application/ld+json">`
// blocks (see src/components/seo/StructuredData.astro). Browsers apply
// `script-src` to every <script> element regardless of its `type`, so a
// strict CSP without `'unsafe-inline'` would silently block those blocks.
// Because every page is still statically prerendered (only the new
// payment/license API routes are server-rendered — see astro.config.mjs's
// adapter comment), there's no per-request server to mint a nonce for
// the HTML that matters here, so the correct fix is a build-time SHA-256
// hash allowlist: this script scans the generated HTML, hashes every
// JSON-LD block it finds, and appends `'sha256-...'` sources to the
// `script-src` directive. This keeps the CSP strict — only the exact,
// known-at-build-time JSON-LD content is allowed to run as an inline
// script; nothing else is.
//
// The computed header set is applied to BOTH targets so the project
// isn't locked to one host:
//   - dist/client/_headers (Netlify/Cloudflare Pages convention)
//   - .vercel/output/config.json's `routes` (Vercel's Build Output API —
//     see https://vercel.com/docs/build-output-api/configuration#routes).
//     Vercel reads config.json from the build's OWN output, generated
//     during this same `npm run build` invocation, unlike vercel.json
//     at the repo root (which Vercel reads BEFORE the build runs and so
//     can't be rewritten with build-time-computed hashes).
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveDistDir } from "./dist-dir.mjs";

const distDir = resolveDistDir();
const headersFile = path.join(distDir, "_headers");
const vercelConfigFile = path.resolve(process.cwd(), ".vercel", "output", "config.json");
const JSON_LD_PATTERN = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self'",
};

function sha256Base64(content) {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

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

async function computeScriptSrcHashes() {
  const htmlFiles = await collectHtmlFiles(distDir);
  const hashes = new Set();
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(JSON_LD_PATTERN)) {
      hashes.add(`'sha256-${sha256Base64(match[1])}'`);
    }
  }
  return hashes;
}

async function updateNetlifyHeaders(cspWithHashes) {
  let headers;
  try {
    headers = await readFile(headersFile, "utf8");
  } catch {
    console.warn("[headers] dist/client/_headers not found; skipping Netlify-format update.");
    return;
  }
  if (!headers.includes("script-src 'self'")) {
    console.warn("[headers] _headers doesn't contain the expected `script-src 'self'` baseline; skipping.");
    return;
  }
  const updated = headers.replace(
    /Content-Security-Policy: .*/,
    `Content-Security-Policy: ${cspWithHashes}`,
  );
  await writeFile(headersFile, updated, "utf8");
  console.log("[headers] Updated dist/client/_headers (Netlify/Cloudflare Pages format) with the hashed CSP.");
}

async function updateVercelConfig(cspWithHashes) {
  if (!existsSync(vercelConfigFile)) {
    console.warn("[headers] .vercel/output/config.json not found; skipping Vercel Build Output API update.");
    return;
  }
  const config = JSON.parse(await readFile(vercelConfigFile, "utf8"));
  config.routes ??= [];

  // Drop any entry this script added on a previous run against the same
  // build output (defensive — this script only runs once per `npm run
  // build` today, but this keeps a second run idempotent rather than
  // duplicating routes).
  config.routes = config.routes.filter((route) => !route.__generatedBy);

  const filesystemIndex = config.routes.findIndex((route) => route.handle === "filesystem");
  const insertAt = filesystemIndex === -1 ? 0 : filesystemIndex + 1;

  const newRoutes = [
    {
      src: "^/(.*)$",
      headers: { ...BASE_SECURITY_HEADERS, "Content-Security-Policy": cspWithHashes },
      continue: true,
      __generatedBy: "generate-response-headers.mjs",
    },
    {
      src: "^/wasm/(.*)$",
      headers: { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=31536000, immutable" },
      continue: true,
      __generatedBy: "generate-response-headers.mjs",
    },
  ];

  config.routes.splice(insertAt, 0, ...newRoutes);

  // __generatedBy is bookkeeping for this script only — Vercel's schema
  // doesn't define it, so strip it before writing the real file.
  const clean = { ...config, routes: config.routes.map(({ __generatedBy, ...route }) => route) };
  await writeFile(vercelConfigFile, JSON.stringify(clean, null, 2), "utf8");
  console.log("[headers] Added security headers + hashed CSP to .vercel/output/config.json.");
}

async function main() {
  const hashes = await computeScriptSrcHashes();
  if (hashes.size === 0) {
    console.warn("[headers] No JSON-LD blocks found in built HTML; script-src left at its 'self'-only baseline.");
  }
  const cspWithHashes =
    hashes.size > 0
      ? BASE_SECURITY_HEADERS["Content-Security-Policy"].replace(
          "script-src 'self'",
          `script-src 'self' ${Array.from(hashes).join(" ")}`,
        )
      : BASE_SECURITY_HEADERS["Content-Security-Policy"];

  await updateNetlifyHeaders(cspWithHashes);
  await updateVercelConfig(cspWithHashes);
}

await main();
