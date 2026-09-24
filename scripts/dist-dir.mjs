// Resolves the actual static-output root. Since Phase 11 added
// @astrojs/vercel (needed for the payment/license API routes), `astro
// build` now splits output into dist/client/ (static HTML/assets) and
// dist/server/ (the serverless function bundle) instead of the old flat
// dist/ — see astro.config.mjs's adapter comment. Falls back to plain
// dist/ if that split ever goes away, so this doesn't silently break if
// the adapter is removed later.
import { existsSync } from "node:fs";
import path from "node:path";

export function resolveDistDir() {
  const clientDir = path.resolve(process.cwd(), "dist", "client");
  if (existsSync(clientDir)) return clientDir;
  return path.resolve(process.cwd(), "dist");
}
