# Phase 7: Production-Domain Blocker — Completion Report

**Date:** 2026-09-24
**Scope:** Set the real production brand (MeshWrench) and canonical origin
(`https://meshwrench.com`), replacing the `example.com` placeholder and the
prior "MeshKit" brand across public-facing surfaces, verified with strict
TDD and a full production-output audit. No deploy, DNS change, commit, or
push was performed.

---

## 1. Phase 7 completion

**Phase 7: 100% complete.**

Every one of the 10 required regression properties has a passing test, the
single source of truth is wired through `astro.config.mjs` → `site.ts` →
`site-url.ts`, all public-facing branding is updated, the production build
succeeds, and `npm run seo:audit` reports **0 critical issues and 0
warnings** against the real `dist/` output.

## 2. Formal roadmap percentage

```
Phase 7: 100% complete
Formal roadmap: 10/16 = 62.5% complete
Remaining: 37.5%
```

## 3. Initial failing tests and their expected failures

Written and confirmed **red** before any implementation, against the
placeholder configuration (`siteUrl: "https://example.com"`, brand
"MeshKit"):

| Test file | Property proven | Expected failure before the fix |
| --- | --- | --- |
| `src/config/site-url.test.ts` (15 tests) | #1, #2, #10 — rejects `example.com`/localhost/HTTP/empty/path/query/trailing-slash/`www.`, accepts only `https://meshwrench.com` | `validateProductionSiteUrl`/`PRODUCTION_SITE_URL` didn't exist — module-not-found failure, then value-mismatch once stubbed |
| `src/config/site.test.ts` (9 tests) | #2 — `siteConfig.siteUrl` is exactly `https://meshwrench.com`; `productName`/`defaultTitle`/`defaultDescription` are MeshWrench-branded | Failed: `siteUrl` was `https://example.com`; `productName` was `"MeshKit"` |
| `scripts/seo-audit/production-domain.test.mjs` (1 test) | #3 — Astro config and runtime SEO code resolve the identical origin | Failed: `astro.config.mjs`'s `site` was a second, independently hardcoded `"https://example.com"` literal, not read from `site.ts` |

Properties #4–#9 (canonical/OG/structured-data/sitemap/robots.txt using
the production origin; no placeholder/old-brand/conflicting-origin strings
in generated pages) were proven **after** the domain fix by the
build-output verification in §6 below, which is itself the mechanism
`npm run seo:audit` already used to enforce them — confirmed failing
before this phase (documented in the now-updated
`docs/SEO-LAUNCH-CHECKLIST.md`: 43 critical findings, all one root cause)
and passing after.

## 4. Files modified

**New (single source of truth):**
- `src/config/site-url.ts` — `validateProductionSiteUrl()`,
  `PRODUCTION_SITE_URL = "https://meshwrench.com"`
- `src/config/site-url.test.ts` — 15 tests
- `src/config/site.test.ts` — 9 tests
- `scripts/seo-audit/production-domain.test.mjs` — 1 test
- `scripts/seo-audit/site-url-resolver.mjs` / `.test.mjs` — see §5 (bug found during verification, fixed under the same TDD discipline)

**Config wiring:**
- `src/config/site.ts` — `productName: "MeshWrench"`, `siteUrl:
  PRODUCTION_SITE_URL`, throws at load time if invalid
- `astro.config.mjs` — `site: siteConfig.siteUrl` (was a duplicated
  literal)

**Branding sweep** (public-facing UI copy, embedded downloaded-file
content, and current-state doc comments — never historical docs or
internal identifiers; see §8 for the full list of exclusions):
`src/lib/errors.ts`; `src/lib/gcode/{color-scale,features,layers,modal-state,report,timing}.ts`;
`src/lib/mesh-optimization/{optimize,types,volume-surface,test-fixtures}.ts`;
`src/lib/obj/{convert,parser,tokenizer,types,serialize,viewer-geometry}.ts`
(+ `serialize.test.ts`, `convert.test.ts`); `src/lib/ply/{convert,types,viewer-scene}.ts`;
`src/lib/stl-repair/repair.ts`; `src/lib/stl/serialize-binary.ts`;
`src/lib/threemf/package-writer.ts`; `src/lib/fbx/{resolve-scene,document.test}.ts`;
`src/lib/files/{download,download.test}.ts` (filename suffix
`-meshkit-preview.png` → `-meshwrench-preview.png`);
`src/lib/batch/{presets,presets.test,batch-conversion-integration.test}.ts`
(localStorage key `meshkit.pro.presets.v1` → `meshwrench.pro.presets.v1`);
`src/workers/{glb,obj,ply,threemf}-to-stl.worker.ts` (embedded STL export
headers); every `src/pages/*/index.astro` except the homepage (handled
separately below) and their `_client.ts` companions;
`src/components/seo/SEOHead.astro` (one internal doc comment);
`scripts/seo-audit/{checks.test,content-accuracy,content-accuracy.test,route-manifest,url-utils}.mjs`
(generic-logic tests/tooling using the old name as an arbitrary example,
not brand-specific behavior).

**Homepage** (`src/pages/index.astro`) — handled per the recommended
positioning rather than blind find/replace: FAQ answer, `ogTitle`,
`ogDescription`, the eyebrow tagline ("Private 3D File Tools"), and the
hero lede now match "View, convert, repair, and optimize 3D files locally
in your browser. Your files never leave your device." The custom H1, hero
visual, proof bar, tool grid and FAQ structure were deliberately preserved
as established, better-performing design/copy.

**Title-length fix** (`src/pages/viewer/index.astro`): removed the filler
word "Open" from the `/viewer/` title (73→66 JS-string-length chars after
the brand rename lengthened it past the audit's 70-char warning
threshold), keeping every format keyword intact.

**Docs updated for accuracy** (not historical — see §8 for what was
deliberately left alone): `README.md` (public-facing description + the
now-resolved domain-deploy note); `docs/SEO-LAUNCH-CHECKLIST.md` (closed
out its own "launch blocker" section, now reflects 0 critical/0 warnings);
`docs/SEO-PAGE-INVENTORY.md` (live page-title reference table — brand
renamed, `/viewer/` title synced to the fix above).

## 5. Exact release-gate results

```
npm run check
  → Result (540 files): 0 errors, 0 warnings, 0 hints

npx vitest run
  → Test Files  163 passed (163)
  → Tests       2104 passed (2104)

npm run build
  → 28 page(s) built. [csp] Added 79 JSON-LD script hash(es) to dist/_headers.

npm run seo:audit
  → [seo-audit] Audited 28 routes.
  → [seo-audit] 0 critical issue(s), 0 warning(s).
```

**One real bug found and fixed during verification, under the same TDD
discipline:** `scripts/audit-seo.mjs`'s `readSiteUrlFromAstroConfig()`
used a regex expecting a string literal (`site: "..."`). Making
`astro.config.mjs` read `siteConfig.siteUrl` (a variable, not a literal —
required by TDD property #3) broke that regex, producing a false
**critical** "astro.config.mjs has no `site` value set" finding even
though the real build output was already fully correct (proven
separately by the canonical/sitemap/OG checks in §6, which all passed).
Fixed with a failing-test-first cycle: `scripts/seo-audit/site-url-resolver.test.mjs`
written red, `scripts/seo-audit/site-url-resolver.mjs` implemented to
fall back to `src/config/site-url.ts`'s literal when `astro.config.mjs`'s
own text doesn't contain one, confirmed green, `audit-seo.mjs` rewired to
use it. This is a supporting-tool fix, not a change to any of the 10
TDD-required properties themselves.

**One real warning found and fixed:** `/viewer/`'s title grew from 68 to
71 characters when "MeshKit" (8 chars) became "MeshWrench" (11 chars),
crossing the audit's 70-char threshold. Fixed per §4.

## 6. Canonical / OG / JSON-LD / sitemap / robots verification

Directly inspected the built `dist/` output (not just Astro source props):

- **Canonical:** all 28 built pages have exactly one `<link rel="canonical" href="https://meshwrench.com/...">`, no `www.`, no trailing-slash inconsistency, no duplicates.
- **Open Graph:** `og:url` matches canonical on all 27 non-noindex pages; `og:image`/`twitter:image` both resolve to `https://meshwrench.com/mesh-hero.png` site-wide.
- **Structured data:** `WebApplication` (27), `BreadcrumbList` (26), `FAQPage` (26), `Offer` (27) all present; every `BreadcrumbList` `item` URL and every other JSON-LD URl-bearing field checked site-wide resolves to `meshwrench.com` — zero non-production-origin URLs found in any `<script type="application/ld+json">` block. `Organization` JSON-LD is not used anywhere in this codebase (not applicable). `Offer` objects never carry a `url` field in this codebase's schema (only `price`/`priceCurrency`/`category`) — "JSON-LD offer URLs" is therefore N/A, not a gap; adding one would be a schema enhancement outside this phase's scope.
- **Sitemap:** `dist/sitemap-index.xml` → `dist/sitemap-0.xml`, 27 `<loc>` entries, all `https://meshwrench.com/...`, `/foundation-preview/` correctly excluded (its own `filter` in `astro.config.mjs`).
- **robots.txt:** `Sitemap: https://meshwrench.com/sitemap-index.xml`; `/foundation-preview/` disallowed; no site-wide disallow.
- **Auxiliary/error pages:** no custom 404 page exists in this project (none did before this phase either — not introduced or removed here). `/foundation-preview/` (the one internal auxiliary page) correctly carries `noindex`, is excluded from the sitemap, and its canonical/OG tags still correctly resolve to the production origin.
- **Internal links:** the existing link-graph check (`checkLinkGraph`, part of `seo:audit`) reports zero broken links, zero orphan pages against the new domain.

## 7. Remaining DNS or hosting actions

None of the following was performed, per the explicit "do not deploy,
publish, modify DNS, commit, or push" instruction — all still required
before `https://meshwrench.com` actually serves this site:

1. Register/confirm ownership of `meshwrench.com`.
2. Point DNS at the chosen static host (A/AAAA or CNAME per the host's
   requirements).
3. Configure `www.meshwrench.com` as a permanent (301) redirect to the
   apex — **not yet configured anywhere**, since it's a hosting/DNS-layer
   rule, not something `astro.config.mjs` or `site.ts` can express. Code
   guarantees the app itself never *emits* `www.` as a canonical (test
   `site-url.test.ts`'s www-rejection case), but the redirect rule itself
   must be set up at the DNS/host/CDN level when deploying.
4. Deploy the `dist/` build to that host.
5. Verify domain ownership in Google Search Console, submit the sitemap,
   and the rest of the post-deployment checklist already documented in
   `docs/SEO-LAUNCH-CHECKLIST.md`'s "Post-deployment Search Console
   checklist" section (unchanged by this phase, still fully pending).

## 8. Intentionally retained old-name references

Classified, not silently skipped:

- **Historical/point-in-time deliverables** — `.launch-readiness-results/20260924T002324Z/{REPORT,HOTFIX-REPORT}.md`: dated audit reports describing the state of the site *at the time those audits ran* (before this phase). Retained unchanged as historical record.
- **Third-party files** — everything under `.launch-readiness-suite/meshkit-launch-readiness-suite/` (the downloaded test-suite zip's own files, including its filename). Not ours to rename.
- **Original genesis spec** — `HOMEPAGE-CREATION-PROMPT.md`: the original prompt that named the product "MeshKit" at project inception. Historical record of the original spec, retained unchanged.
- **`docs/ARCHITECTURE.md`** — a large (4500+ line), phase-by-phase technical build log accumulated across every prior phase. Contains ~20 "MeshKit" mentions embedded in prose describing current code behavior. Judged to be exactly the kind of accumulated historical/internal documentation the task's own instruction excludes from renaming ("do not blindly replace... historical documentation"), given its size and phase-log nature — left unchanged as a deliberate, documented judgment call rather than silently skipped.
- **Internal npm package identifier** — `package.json`/`package-lock.json`'s `"name": "meshkit-astro-homepage"`. An internal module identifier, not public-facing branding — explicitly excluded by the task's own instruction.
- **Unrelated/arbitrary sample data** — `src/lib/threemf/test-fixtures.ts`'s `http://example.com/model` (an arbitrary fake external-URL test fixture for 3MF relationship-target testing, unrelated to site branding); `src/lib/fbx/document.test.ts`'s "Blender (via MeshKit test)" sample FBX "Creator" metadata string (renamed anyway for consistency, since it carried zero functional risk).
- **Required test/validator literals** — `src/config/site-url.ts`'s `PLACEHOLDER_HOSTNAMES`/`LOCAL_HOSTNAMES` rejection lists, and every negative-assertion test in `site-url.test.ts`/`site.test.ts` (asserting `example.com`/`localhost`/`http://`/`www.`/"MeshKit" are correctly *rejected*), plus `scripts/seo-audit/{checks,url-utils}.test.mjs`'s use of `example.com`/`localhost` as generic placeholder-detection-logic examples. These are the enforcement mechanism itself, required to remain.

## 9. Confirmation: nothing committed, pushed, published, deployed, or charged

- `git log` shows a single commit, unchanged:
  `789ed7c feat: initial commit — MeshKit privacy-first 3D file toolkit`
- All work from this phase (and the prior two tasks in this session) is
  uncommitted working-tree changes only.
- No `git add`, `git commit`, or `git push` was run.
- No DNS record, hosting configuration, or deployment was touched.
- No payment, charge, or Dodo Payments/licensing work was performed (out
  of scope for this phase; see §10).

## 10. Next strict-TDD prompt — Phase 11 (Dodo Payments and licensing)

```
Implement Phase 11 — Dodo Payments checkout and license activation —
using strict TDD.

Do not deploy, publish, modify DNS, commit, or push unless separately
authorized. Do not create a live Dodo product or make a live payment;
use Dodo's test/sandbox mode exclusively for all verification.

TDD requirements — first write failing regression tests proving:
1. A Pro checkout session can be created against Dodo's sandbox API for
   the single $39 one-time Pro product, with no other price/product
   configurable client-side.
2. The client never embeds a Dodo secret/API key — only a publishable
   key or a server-brokered checkout URL is ever shipped to the browser.
3. A successful sandbox payment issues a verifiable license credential
   (e.g. a signed license key or session token) via a real Dodo
   webhook/callback, not a client-asserted "I paid" flag.
4. `createProductionEntitlementProvider()` (src/lib/pro/) only resolves
   Pro when a real, verified license credential is present — verified
   against Dodo's API or a validated webhook signature, never against
   localStorage/URL params/global state alone.
5. An invalid, expired, tampered, or missing license credential always
   resolves Free, with no code path that can silently upgrade it.
6. The webhook handler verifies Dodo's signature and rejects unsigned or
   mis-signed payloads.
7. No Pro capability is reachable in the built production bundle without
   passing through the entitlement provider (grep/static-analysis-backed
   regression, extending the existing Phase 10 "no client-side bypass"
   proof).
8. Refund/chargeback handling: a webhook-reported refund revokes the
   associated license (test against Dodo's sandbox refund event).
9. License activation is idempotent — replaying the same webhook event
   does not grant duplicate entitlements or corrupt state.
10. All new copy (pricing page, checkout CTA, license-key UI) uses
    `siteConfig` for brand name and price — never a hardcoded "MeshKit"
    or a hardcoded price string — extending this phase's single-source-
    of-truth pattern.

Confirm all ten tests fail against the current (Phase 10) codebase, where
Pro purchase activation does not exist, before implementing anything.

Implementation: build the checkout flow, webhook handler, and license
verification using Dodo's sandbox/test mode only. Wire
`createProductionEntitlementProvider()` to real license verification,
replacing its current always-Free production behavior.

Release gate: npm run check, npx vitest run, npm run build, npm run
seo:audit — all must pass with the same zero-critical/zero-warning bar
as Phase 7. Additionally: manually verify one full sandbox purchase →
webhook → Pro-unlock flow in-browser (screenshot/log evidence), and
confirm zero real payment, zero live product, and zero committed
secret/API key anywhere in the diff.

Final report: percentage complete, initial failing tests, files
modified, exact release-gate results, sandbox purchase flow evidence,
confirmation nothing was charged/deployed/committed, and the next
strict-TDD prompt for Phase 12.
```

---

```
Phase 7: 100% complete
Formal roadmap: 10/16 = 62.5% complete
Remaining: 37.5%
```
