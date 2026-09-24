# SEO launch checklist (Phase 7)

This is the pre-launch checklist for MeshWrench's static site — what's
verified automatically by `npm run seo:audit` (`scripts/audit-seo.mjs`),
what's verified by tests, and what was verified manually in-browser.

## ✅ Resolved: production domain is configured

The approved production brand and domain (`MeshWrench` /
`https://meshwrench.com`) are now set. `src/config/site.ts`'s
`siteConfig.siteUrl` reads the single literal source of truth in
`src/config/site-url.ts`'s `PRODUCTION_SITE_URL`, and `astro.config.mjs`'s
`site` reads `siteConfig.siteUrl` directly rather than duplicating it —
one value, enforced at build time by `validateProductionSiteUrl()`
(`src/config/site-url.ts`), which rejects `example.com`, localhost, HTTP,
a `www.` host, and several other malformed-origin shapes so a future
regression to a placeholder fails loudly instead of silently shipping.
See `src/config/site-url.test.ts` for the regression suite proving this,
and `scripts/seo-audit/production-domain.test.mjs` proving
`astro.config.mjs` and `src/config/site.ts` resolve the identical origin.
`robots.txt` needs no edit for domain changes — it's a dynamic endpoint
(`src/pages/robots.txt.ts`) that reads `siteConfig.siteUrl` directly.

As of the last audit run (`dist/seo-audit.json`): **0 critical issues, 0
warnings.**

## What `npm run seo:audit` checks automatically

Run via `npm run seo:audit` (builds first, then inspects `dist/`). Full
per-route detail lands in `dist/seo-audit.json`; a human-readable summary
prints to the console. Exits non-zero on any critical issue.

- [x] Route inventory generated from `src/pages/**/index.astro` +
      `src/config/tools.ts`, cross-checked against `dist/` output
      (`scripts/seo-audit/route-manifest.mjs`, tested against the real
      `src/pages/` glob in `route-manifest.test.mjs`)
- [x] Every indexable page has exactly one non-empty `<title>`, no exact
      duplicates across the site, warns on unusually short/long titles
- [x] Every indexable page has a unique meta description, warns on
      unusually short/long or near-duplicate-opening descriptions
- [x] Exactly one `<h1>`, exactly one `<main>`, no heading-level skips,
      `<nav>`/`<footer>` landmarks present
- [x] `<html lang>` and `<meta name="viewport">` present on every page
- [x] Canonical: present, absolute, https, no fragment/query, resolves to
      a real built route, agrees with the route manifest's expected path,
      consistent trailing-slash policy — all on `https://meshwrench.com`
- [x] `robots` meta: indexable pages never `noindex`; development-only
      pages always `noindex, nofollow`
- [x] Structured data: valid JSON, `BreadcrumbList` position order and
      absolute URLs, `FAQPage` questions matched against visible
      `<details><summary>` text on the same page (never claims a question
      is answered on-page when it isn't rendered), `WebApplication`
      required fields present, no empty/undefined properties, no
      duplicate `@id`
- [x] Open Graph: required properties present, `og:image` resolves to a
      real asset in `dist/`, image alt text present, `twitter:card`
      present — image URLs absolute on `https://meshwrench.com`
- [x] Sitemap: every indexable route present exactly once, no
      development-only/alias routes included, no duplicate `<loc>`,
      absolute https URLs on `https://meshwrench.com`
- [x] `robots.txt`: valid syntax, no site-wide disallow, has a
      `Sitemap:` line pointing at
      `https://meshwrench.com/sitemap-index.xml`, development-only routes
      disallowed
- [x] Internal link graph: every `href` resolves to a real built route (or
      a declared redirect alias), every indexable page (except the
      homepage) has at least one incoming internal link — **zero broken
      links, zero orphan pages** in the current build
- [x] Content-accuracy scan (`scripts/seo-audit/content-accuracy.mjs`):
      flags guaranteed-repair/printability language, "100% repair",
      "perfect repair", unsupported "best" superlatives, AI/ML claims,
      server-upload claims, and any reference to the never-built G-code
      Viewer — **zero findings** in the current build (one false positive
      on a legitimate "cannot guarantee printability" disclaimer was
      found and fixed in the scanner itself during this phase; see the
      negation-aware regex and its test in `content-accuracy.test.mjs`)
- [x] File input accessibility: every `<input type="file">` has an
      `aria-label` or an associated `<label for>`
- [x] Anchor-text quality: warns on vague text like "click here"

## What's verified by unit/integration tests (not the build-output audit)

`npm run test` — colocated with the code they test, per this project's
own convention (`src/**/*.test.ts`, `scripts/**/*.test.mjs`):

- [x] Route classification validity and completeness
      (`scripts/seo-audit/route-manifest.test.mjs`)
- [x] URL normalization, placeholder-domain rejection, trailing-slash
      policy, absolute-URL validation (`scripts/seo-audit/url-utils.test.mjs`)
- [x] Every per-page check rule, including structured-data parsing and
      breadcrumb/FAQ visible-content agreement
      (`scripts/seo-audit/checks.test.mjs`)
- [x] Title/description uniqueness, sitemap agreement, robots.txt
      parsing, link-graph broken-link and orphan detection
      (`scripts/seo-audit/sitewide-checks.test.mjs`)
- [x] Content-accuracy phrase matching, including the negation edge case
      (`scripts/seo-audit/content-accuracy.test.mjs`)
- [x] Tool registry: every `relatedToolIds` entry points at a real tool,
      every *ready* tool's related *ready* tools link back reciprocally,
      unique ids/paths, no fabricated `gcode` format claim
      (`src/config/tools.test.ts` — this test suite caught and this phase
      fixed 25 real one-directional relatedToolIds relationships)

## Manually verified in-browser this phase

- [x] Homepage: tool count, format list and "also live"/"planned next"
      lists render correctly from the registry, no G-code, no stale
      "planned" claims for shipped tools, all 18 tool links resolve
- [x] `/stl-viewer/`'s related-tools section (previously the actively
      broken one — see "Bugs and stale content" below): now renders 16
      real, correctly-linked related tools instead of 7 hardcoded,
      unlinked "Planned" entries
- [x] Mobile layout at 375px: homepage and a tool page checked for
      horizontal overflow; the one apparent 27px overflow found was
      traced to a viewport-emulation reporting quirk in the browser tool
      itself (`window.innerWidth` exactly equalled
      `document.documentElement.scrollWidth`, meaning zero actual
      scrollable overflow; the one element whose own bounding rect
      exceeded the viewport, `.final-aura`, sits inside `.final-cta`,
      which already declares `overflow: hidden` in `src/styles/global.css`
      and was unmodified by this phase) — not a real page defect
- [x] Console/network privacy sweep on the homepage and `/stl-viewer/`:
      no uploads, no external requests beyond same-origin assets

## Performance and bundle isolation

Re-confirmed unchanged from every prior phase's own verification (Phase 7
added no new client-side JavaScript, workers, or heavy dependencies):

- [x] Homepage bundle contains zero references to any tool's worker,
      Three.js viewport code, or format-parsing library — confirmed via
      `dist/index.html`'s own script/link tags in this phase's build
- [x] Every viewer/converter/diagnostic/repair page's heavy code
      (Three.js, its own worker) loads only on that page
- [x] No new render-blocking third-party scripts, no advertising scripts
      were added
- [x] The homepage hero image (`mesh-hero.png`, the LCP candidate) is
      **not** lazy-loaded; the below-the-fold decorative copy of the same
      image in the final CTA section **is** lazy-loaded — unchanged
      policy, now with corrected `width`/`height` attributes (were
      hardcoded to 1280×1280, the file is actually 1254×1254 — fixed this
      phase to remove a small layout-shift risk)
- [ ] A full local Lighthouse run (homepage, Universal Viewer, one
      converter, STL Checker, STL Repair; mobile + desktop) was **not**
      run this phase — no Lighthouse CLI/CI tooling exists in this
      project yet, and adding a new heavyweight dependency purely for a
      one-off local audit was judged out of proportion to this phase's
      scope. Documented here as a genuine gap, not silently skipped.
      Recommended for Phase 8 or a dedicated performance pass: `npx
      lighthouse` against `npm run preview`'s local server needs no new
      `package.json` dependency at all.

## Accessibility

- [x] Landmarks: `<nav>`, `<main>`, `<footer>` present on every page
      (enforced by the audit's `checkHeadings`)
- [x] File inputs have accessible labels (enforced by
      `checkFileInputLabels`)
- [x] Heading hierarchy: no skips (enforced by `checkHeadings`) — this
      phase found and fixed two real skips (`STLDiagnosticsDetails.astro`
      and `STLRepairPlan.astro` both used `<h3>` for their first
      subsection heading with no intervening `<h2>`; both bumped to
      `<h2>`, five pages affected)
- [x] Keyboard/focus-visibility and reduced-motion behavior were verified
      manually in Phase 4F/5/6's own browser-verification passes and are
      unchanged by this phase's content-only edits
- [ ] A full automated accessibility scan (axe-core or equivalent) was
      **not** added this phase — same reasoning as the Lighthouse gap
      above; the structural checks the audit script already runs (single
      h1, landmark presence, labelled inputs, heading order) cover the
      SEO-relevant subset of accessibility, not the full WCAG surface

## Post-deployment Search Console checklist (documented, NOT executed)

None of the following has been performed — no domain is verified, no
sitemap was submitted, no indexing was requested, per this phase's
explicit "do not deploy, publish, or modify DNS" instruction. The domain
(`https://meshwrench.com`) is now configured in code, but DNS/hosting and
this whole checklist remain undone until separately authorized. This is
the order to follow once the site is actually deployed and the domain is
live:

1. **Verify domain ownership** in Google Search Console (DNS TXT record
   or HTML file, whichever the hosting provider makes easier).
2. **Inspect the homepage and a representative tool URL from each
   workflow cluster** (e.g. `/`, `/stl-viewer/`, `/3mf-to-stl/`,
   `/stl-checker/`, `/stl-repair/`) with the URL Inspection tool to
   confirm Google can fetch and render them as expected.
3. **Confirm `robots.txt` and the sitemap are publicly reachable** at the
   real domain (`/robots.txt`, `/sitemap-index.xml`) — both are dynamic/
   generated, so this is really "confirm the deploy actually shipped
   them," not a new implementation step.
4. **Submit the sitemap** (`/sitemap-index.xml`) in Search Console.
5. **Request indexing only for the highest-priority representative
   pages** — the homepage and each `indexable-primary` route's own
   canonical intent leader (not every one of the 18 indexable pages at
   once).
6. **Monitor the Page Indexing report** over the following days/weeks for
   unexpected exclusions.
7. **Monitor Core Web Vitals** (field data, once enough real traffic
   accumulates — lab data from this phase's deferred Lighthouse run is a
   readiness signal only, never a substitute for this).
8. **Monitor the structured-data reports** (Search Console's own rich-
   result status pages) for each type shipped: `WebApplication`,
   `BreadcrumbList`, `FAQPage`.
9. **Review Search queries and landing pages** in the Performance report
   once enough data accumulates, to see which actual queries are driving
   traffic to which tool pages.
10. **Feed real demand data into Phase 16** (or whichever future phase
    covers format/tool prioritization) — e.g. if "fix inverted normals
    stl" drives meaningfully more traffic than expected, that's a signal
    for future content/tooling investment, not something to guess at now.

No placeholder Search Console verification tag was added to any page —
adding one before a real property exists would be exactly the kind of
premature, potentially-wrong metadata this phase's own audit is built to
catch elsewhere.
