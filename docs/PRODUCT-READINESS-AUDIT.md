# Product readiness audit — Free and Pro

**Date of this audit run's evidence:** repository state as of the Phase 7
working tree (single initial commit `789ed7c`, everything since
uncommitted). **Scope:** this document only assesses what exists; it adds
no features, fixes no bugs, and does not touch the domain configuration.

## Phase 8 addendum (read this first)

Two of this document's own findings have since changed, both addressed as
explicit, tracked work rather than by editing the original text below
(kept as-written, as a record of what the audit found at the time):

- **Section 4's structured-data finding is fixed.** The homepage's
  `WebApplication` JSON-LD no longer emits a priced `$39` `Offer` — Phase
  8's own Step 0 removed it via strict TDD (a failing test first, in
  `scripts/seo-audit/checks.test.mjs`), confirmed by rerunning `npm run
  seo:audit` with an identical 0-non-domain-critical, 0-warnings result.
  See `docs/ARCHITECTURE.md`'s "Step 0 (Phase 8)" section.
- **Section 1's tool count is now 21, not 18** — Phase 8 shipped the
  first optimization tool (`reduce-stl-size`, plus its two secondary SEO
  routes `simplify-stl` and `stl-triangle-reducer`), all `"ready"` in the
  registry. Section 2 ("which planned free tools remain missing") is now
  accurate as "none" — every registry entry is `"ready"`.
- **Section 7's reproducibility finding has gotten worse, not better** —
  Phase 8 added a substantial new library (`src/lib/mesh-optimization/`,
  14 modules) entirely uncommitted, same as every phase since the initial
  commit. The recommendation stands unchanged: commit the working tree in
  logical chunks at the user's next explicit request. This audit (and
  Phase 8) still commits nothing itself.
- Sections 3, 5 and 6 (Pro functionality, batch architecture, the
  payment/licensing decision) are **unchanged** — Phase 8 built no Pro,
  batch, or payment code, per its own explicit scope boundary.

## Phase 8 closeout addendum

A follow-up TDD pass completed the acceptance criteria the initial Phase
8 merge left open:

- **Section 1's "12 not-recently-re-verified tools" smoke-pass
  recommendation is now done — 12 of 12 verified**, not 11 of 12. The
  initial Phase 8 pass froze at 11 of 12 because it judged hand-
  constructing a valid binary FBX fixture impractical within that phase's
  scope; this closeout instead generated a temporary binary FBX 7400
  fixture (a 12-triangle cube) using only `src/lib/fbx/test-fixtures.ts`'s
  own existing production test helpers (`buildFBXBinary`, `geometryNode`,
  `objectsSection`, `connectionsSection`) — never a hand-authored file and
  never a second FBX parser/writer — and drove `/fbx-viewer/` through it
  live in-browser: file selection, successful resolution (1 model, 1
  geometry, 1 mesh instance, 12/12 triangles rendered, 0 skipped), the
  info panel and scene tree populating correctly, zero console errors,
  zero unexpected network requests, "Start over" (clear/reset) working,
  and an invalid (ASCII) file producing a clear rejection message with a
  working "try again" recovery path back to a valid load. The temporary
  fixture and its generator script were both removed afterward.
- **Surface-area and closed-shell volume comparison, deferred in the
  initial Phase 8 pass, is now implemented** — see
  `docs/ARCHITECTURE.md`'s "Surface-area and closed-shell volume
  comparison (Phase 8 closeout)" section for the full contract, including
  the preset quality-policy thresholds that now cap a result below
  `target-achieved`/`reduced-safely` when a preset's own surface-area/
  volume drift limit is exceeded.

## Phase 9 addendum

- **Section 1's tool count is now 26, not 21** — Phase 9 shipped the
  first G-code tool cluster (`gcode-viewer`, plus its four secondary SEO
  routes `gcode-visualizer`, `gcode-simulator`, `gcode-layer-viewer`,
  `gcode-toolpath-viewer`), all `"ready"` in the registry. This is a
  static viewer/visualizer/visual simulator only — it never executes
  G-code, never uses WebSerial, and never connects to a printer.
- **A new stale-content false positive was found and fixed.**
  `scripts/seo-audit/content-accuracy.mjs`'s own Phase 7 staleness guard
  hard-coded a rule flagging any mention of "G-code Viewer" as a stale
  claim (from Phase 7's own fabricated-homepage-card finding, when no
  G-code tool existed). Now that Phase 9 built a real one, that rule was
  itself the stale artifact — it fired as a false positive on every page
  that legitimately mentions the now-real tool, including the tool's own
  pages. Removed via strict TDD (failing test first, in
  `content-accuracy.test.mjs`), confirmed by rerunning `npm run
  seo:audit` with an identical 0-non-domain-critical, 0-warnings result.
- **`src/config/tools.test.ts`'s own "no G-code tool has ever been
  built" regression guard was similarly retired** and replaced with a
  guard for the actual current invariant: only the five real Phase 9
  tools may claim `gcode` format support, and none of them (nor any
  other tool) may claim G-code *conversion* — this project still never
  slices STL to G-code.
- **A genuine bug was found during browser verification, not by the unit
  suite**, and fixed with dedicated regression tests: `GCodeStatistics`'s
  `linearMoveCount` was derived as `generatedSegments - arcLineCount`,
  which is silently wrong whenever an arc expands into more than one
  render segment (true for any real curve — a 15mm-radius semicircle
  alone produces ~31 segments at this tool's own default chord-error
  tolerance). Fixed by tracking the real G0/G1 line count directly. See
  `docs/ARCHITECTURE.md`'s "Phase 9 completion summary" for the full
  TDD-discovery record, including a separate R-form arc sign-convention
  bug caught by `arcs.ts`'s own unit tests before merge.
- **Section 7's reproducibility finding has gotten worse, not better,
  again** — Phase 9 added another substantial new library
  (`src/lib/gcode/`, 20 modules) entirely uncommitted, same as every
  phase since the initial commit. The recommendation stands unchanged.
- Sections 3, 5 and 6 (Pro functionality, batch architecture, the
  payment/licensing decision) are **unchanged** — Phase 9 built no Pro,
  batch, or payment code, per its own explicit scope boundary.

## Phase 9 closeout addendum

- **Temperature color mode shipped and `"mixed"` layer-detection mode
  is now real** — both were open acceptance-criteria items after Phase
  9's initial build; a dedicated closeout pass completed them under the
  same strict-TDD discipline. See `docs/ARCHITECTURE.md`'s "Phase 9
  closeout" for the full record.
- **A severe, previously-undetected defect was found and fixed** during
  the closeout's own cancellation-and-recovery verification:
  `ChunkedLineDecoder` (`src/lib/gcode/chunked-lines.ts`) degraded to
  roughly O(linesPerChunk²) once a chunk held many thousands of short
  lines (any real multi-hundred-KB G-code file), and had an independent
  correctness bug that spuriously truncated ordinary short lines
  whenever a chunk's total queued-up text exceeded the line-length
  ceiling — silently corrupting output and manufacturing false
  "malformed line" warnings. Before this fix, the tool's real-world
  usable file size was far smaller than its documented 400MB/20M-line
  safety ceilings; a 2,000,000-line file that now completes in ~12s
  would previously never have finished in practice. Fixed with
  regression tests for both the performance and correctness cases in
  `chunked-lines.test.ts`. This affected every G-code route (all five
  share the same worker/decoder), not just `gcode-viewer`.
- **Full live browser-verification matrix completed** across all five
  routes (playback, cancellation, every display mode, 375px responsive/
  accessibility, screenshot + JSON report content, printer-control
  absence) — see `docs/ARCHITECTURE.md`'s "Phase 9 closeout" for the
  complete list. No temporary fixtures were committed or left in
  `public/`.
- Section 7's reproducibility finding is otherwise unchanged by this
  closeout — no new files were committed.

## Phase 10 addendum

Sections 3, 5 and 6 below are now **partially stale** — read them
alongside this addendum, not in isolation.

- **Section 3 ("whether any Pro functionality exists beyond copy") is
  now fully answered: yes, batch processing exists and works, for
  every batch-capable operation.** Multi-file batch conversion
  (3MF/OBJ/GLB/PLY→STL, STL→OBJ, STL→3MF) is live-wired into all 6
  existing conversion pages; STL Repair and STL Optimization are
  likewise live-wired into their own pages (as of the Phase 10 closeout
  — see the addendum below), using a plan-before-mutation flow (file
  intake → analyze/plan → confirm and run) rather than the converters'
  immediate-run flow. It is still not PURCHASABLE — the production
  entitlement provider always resolves Free (see below) — so a real
  user cannot yet reach it; it exists and is fully tested/verified, but
  Pro activation itself remains exactly 0% implemented, unchanged from
  before Phase 10.
- **Section 5's "what architecture is required for batch conversion,
  repair and optimization" is now answered and built**, not merely
  speculated: `src/lib/batch/` — job queue/state machine, a
  concurrency-bounded scheduler (default 1, capped at 2, now
  user-adjustable at runtime — see the closeout addendum), a
  deterministic memory-budget estimator, an exhaustive 8-operation
  adapter registry, a generic `PlanWorkflow` state machine for
  repair/optimize planning, ZIP/report builders, and local preset
  persistence with a full manage UI. See `docs/ARCHITECTURE.md`'s "Pro
  Feature Set (Phase 10)" and "Phase 10 closeout" for the full
  architecture.
- **Section 6's payment/licensing decision remains fully unresolved —
  Phase 10 deliberately did not touch it.** No Dodo Payments
  integration, no checkout, no license issuance or validation, no
  license-key entry exists anywhere in `src/` (verified by a dedicated
  test, `production-isolation.test.ts`, that greps the whole source
  tree for each of these terms). This is Phase 11's explicit scope —
  see `docs/ARCHITECTURE.md`'s "Phase 11 handoff."
- **A new entitlement interface exists** (`src/lib/pro/`, 7 modules, 68
  tests) as a genuinely fail-closed abstraction: every status except
  `"pro"` is structurally forced to zero capabilities at the one
  snapshot-construction choke point, and the production provider is
  verified (source AND built-`dist/`-bundle grep) to contain no bypass
  — no query string, no `localStorage`, no global.
- **A real architectural bug was found and fixed during this phase's
  own live browser verification, not by the unit suite**: the
  scheduler's `dispatch()` call to `queue.transition()` synchronously
  triggered a REENTRANT call back into the scheduler's own `pump()`
  (via its queue-change subscription), corrupting FIFO dispatch order.
  A `isPumping` reentrancy guard fixed it; `scheduler.test.ts`'s
  existing test suite (already covering ordering) caught the effect
  immediately once written, before any live testing was needed —
  worth recording since it demonstrates the value of the ordering
  tests specifically, not just their existence.
- **A second bug was found live, not by any unit test**: the batch
  workspace UI's output-filename resolution was being recomputed (and
  re-reserved against the shared collision tracker) on every progress
  re-render, not once per job — filenames like `part1 (17).stl`
  instead of `part1.stl` after a few progress ticks. Fixed by
  memoizing each job's resolved filename exactly once. This class of
  bug (a UI-layer defect invisible to the underlying logic's own,
  correctly-passing unit tests) is exactly why the "live browser
  verification" requirement exists independent of unit coverage.
- Section 7's reproducibility finding is unchanged in kind — Phase 10
  added two more substantial, entirely uncommitted library trees
  (`src/lib/pro/`, `src/lib/batch/`), same as every phase since the
  initial commit.

## Phase 10 closeout addendum

A follow-up strict-TDD pass completed the acceptance criteria the
initial Phase 10 merge left open — see `docs/ARCHITECTURE.md`'s "Phase
10 closeout" for the full technical record. Summary relevant to this
audit's own findings:

- **The `?devPro=1` dev-only URL-unlock mechanism (mentioned above as
  "no bypass exists — no query string...") has been removed entirely**,
  not merely disabled — replaced by explicit constructor dependency
  injection for entitlement. This is a strictly stronger guarantee than
  the addendum above originally described: there was never a
  production bypass, and now there isn't even a *dev-only* one left to
  reason about.
- **STL Repair and STL Optimization batch UI — the one item Section 3's
  original Phase 10 addendum flagged as still open — is now wired**,
  with a plan-before-mutation workflow, saved presets (full manage UI:
  rename/delete/export/import), and live-adjustable concurrency (1–2
  files).
- **Two more real bugs were found by live browser verification, not by
  the unit suite** (the same pattern the Phase 10 addendum above
  already flagged as a recurring, valuable category): a plan-review
  screen that silently sat on "Pending." for the entire duration of a
  multi-second analysis (no subscription to the underlying state
  machine's own change notifications), and planning failures collapsed
  into a generic "Something went wrong" instead of the specific,
  already-computed `SafeError` reason. Both fixed with regression tests
  — see `docs/ARCHITECTURE.md`'s "Phase 10 closeout" for detail.
- **Exact completion status**: Phase 10 is 100% complete. Pro
  capabilities are implemented; Pro purchase activation remains
  unavailable; payments/licensing remain 0% implemented until Phase 11.
  Nothing from this closeout pass was committed, pushed, published or
  deployed.
- Section 7's reproducibility finding is otherwise unchanged by this
  closeout — no new files were committed.

## Phase 10 hotfix addendum

A subsequent independent launch-readiness audit (not part of this
document's own Phase 10 closeout addendum above) found one real defect
in the conversion family specifically: `resultMeta` embedded raw source-
geometry arrays in downloadable batch reports/ZIPs, crashing with an
uncaught `RangeError` for large files. A narrowly-scoped, strict-TDD
hotfix fixed it — see `docs/ARCHITECTURE.md`'s "Phase 10 hotfix" for the
full technical record. Summary relevant to this audit's own findings:

- **The paid-product verdict's one blocking defect is resolved.** All
  six conversion operations now project an explicit, bounded, allowlisted
  `resultMeta` (`src/lib/batch/conversion-result-meta.ts`) instead of
  spreading a worker's raw result, plus a defense-in-depth guard
  (`src/lib/batch/result-meta-guard.ts`) applied uniformly to every
  operation's report/ZIP metadata. Repair and optimize were verified
  unaffected both before and after the fix — their own diagnostic
  fields (`boundaryEdgeCount`, `outcome`, `deviation`,
  `surfaceAreaBefore/After`, `volumeBefore/After`, etc.) remain
  completely intact.
- **70 new tests**, plus a live re-verification of concurrency 2,
  genuine in-flight cancellation, retry, mixed valid/invalid isolation,
  and the exact original crash reproduction (now fixed) in a real
  browser for two of the six conversion families.
- **Paid commerce/licensing remains entirely unaffected and unchanged**
  by this hotfix — still 0% implemented, still Phase 11's own explicit
  scope; this was a Pro-*capability* correctness fix only.
- Nothing from this hotfix was committed, pushed, published, deployed,
  or charged.

## 1. Which free workflows genuinely work

**18 tools are registered `"ready"`** in `src/config/tools.ts`, each with
its own built, indexable page:

| Cluster | Tools | Evidence this phase |
| --- | --- | --- |
| Viewing | STL, OBJ, 3MF, GLB, PLY, FBX Viewer + Universal Viewer (7) | Build succeeds for all 7 routes; each has its own parser/worker/viewer-scene module with a colocated `*.test.ts` suite (part of the 1,212 passing tests below). `/stl-viewer/` and the homepage were directly exercised in-browser during Phase 7's own audit work (file load, related-tools links, structured data). The other 6 viewers were **not** re-driven through a live file-load in this session — their functional evidence is their own test suites plus a clean production build, not a fresh manual click-through. |
| Conversion | 3MF/OBJ/GLB/PLY→STL, STL→OBJ/3MF (6) | Same basis: passing colocated test suites (parser + converter + serializer, each independently tested against fixtures) and a clean build. Not re-driven live this session. |
| STL troubleshooting | STL Checker, STL Validator, STL Repair, Make STL Watertight, Repair Non-Manifold STL (5) | **Most deeply verified cluster in the repo.** STL Repair's own 15 end-to-end tests each reparse and re-diagnose their *actual output bytes* with the production parser — never trust the attempted operation alone. This phase and Phase 6 both drove STL Repair live in-browser repeatedly (plan→repair cycles, ASCII input, concave holes, branched boundaries, cancellation, recovery). STL Checker/Validator share Repair's own diagnostics pipeline. |

**Verdict on "genuinely work":** high confidence for the STL
troubleshooting cluster (direct, repeated, this-session browser
verification of real repair outcomes against re-parsed output) and the
homepage/STL Viewer (direct verification this phase). **Moderate,
test-suite-based confidence** (not freshly re-verified live) for the other
12 viewer/converter tools — their own historical phase completion reports
describe browser verification passes that this audit did not re-run. This
is a real gap for a "genuinely work" claim, not something to paper over:
recommend a fresh smoke pass (one file through each of the 12
not-recently-re-verified tools) before treating this as a hard launch
gate, though nothing found in this audit suggests they're broken — `astro
check`, all 1,212 tests, and the production build are all clean.

## 2. Which planned free tools remain missing

**One:** `reduce-stl-size` (id in the registry), targeting
`/reduce-stl-file-size/`, category `optimizer`, status `"planned"`. No
page exists yet — this is exactly Phase 8's own scope (STL Optimization
Tools), already handed off in `docs/ARCHITECTURE.md`. No other planned-
but-missing free tool exists in the registry; every other entry is
`"ready"`.

## 3. Whether any Pro functionality exists beyond documentation or copy

**No.** A full-repository search for payment, licensing, subscription,
checkout, or Pro-gating code found:

- **Zero** matches for `stripe`, `paypal`, `checkout`, `payment`,
  `license key`, or any licensing API/server pattern anywhere in `src/`.
- **Zero** matches for a feature-flag or gate pattern (`isPro`,
  `proEnabled`, `unlockPro`, `proTier`, `proAccess`, `proLicense`, etc.)
  anywhere in `src/`.
- The only file matching payment-adjacent keywords at all is
  `src/pages/index.astro`, and both matches are FAQ/marketing **copy**
  ("Is Pro a subscription? No, the planned price is $39…", "No
  subscription anxiety") — not code.
- `FileSession` (`src/lib/files/file-session.ts`) is explicitly documented
  as wrapping **one** `File` for the lifetime of one tool interaction; no
  batch/queue primitive exists anywhere to gate in the first place.
- No account system, no database, no server — consistent with the
  site's own "100% local processing" privacy promise, but also meaning
  there is currently **no mechanism by which a Pro purchase could even be
  checked or enforced** even if payment were added tomorrow.

**Verdict: Pro is 100% marketing positioning today, 0% functionality.**
This is consistent with every prior phase's explicit instruction ("Do not
build payment or licensing yet") — not a bug, a deliberate and
so-far-honored scope boundary.

## 4. Whether any page misleadingly suggests Pro can be purchased

**Visible copy: no.** Every Pro mention found is explicitly hedged —
"planned price," "planned for Pro," "Pro is designed for…" — and the
homepage's own Pro CTA (`<a class="button button-pro" href="#final-cta">
See the Pro promise</a>`) is an in-page anchor scroll, not a checkout
link. No page has a working "Buy" or "Upgrade" button anywhere in the
repository.

**Structured data: a real, if narrow, finding.** The homepage's
`WebApplication` JSON-LD (`src/pages/index.astro`, rendered by
`SEOHead.astro`) declares a schema.org `Offer` for the $39 Pro tier:

```json
{ "@type": "Offer", "price": "39", "priceCurrency": "USD", "category": "Lifetime Pro license" }
```

A bare `Offer` with a `price`/`priceCurrency` and no `availability` field
carries an implicit "this can be bought now" semantic in schema.org/rich-
result tooling — independent of the honest "planned" wording in the
*visible* page text, which structured data doesn't inherit. This is a
**real, currently-shipping discrepancy between visible honesty and
structured-data claims**, missed by Phase 7's own SEO audit (which
checked structured data for required-field completeness and visible-
content agreement for FAQ schema specifically, not for this kind of
implied-purchasability). **Recommended fix, not applied by this audit:**
either remove the Pro `Offer` entry from structured data entirely until a
real purchase path exists, or add `"availability":
"https://schema.org/PreOrder"` (schema.org's own vocabulary for "not yet
purchasable, but planned") to make the structured data as honest as the
visible copy already is.

## 5. What architecture is required for batch conversion, repair, and optimization

None of it exists yet; every layer would need new design:

- **File intake:** `LocalFilePicker.astro`'s `<input type="file">` has no
  `multiple` attribute, and `FileSession` wraps exactly one `File`.
  Batch needs a new multi-file intake component and a session type that
  tracks N files' independent lifecycles (each with its own
  dispose/cleanup), not a trivial extension of the current one.
- **Worker orchestration:** every tool page uses either a single-
  persistent-worker pattern (repair, diagnostics) or a per-load worker
  spin-up (converters). Neither is designed for "process N files, some
  concurrently, without overwhelming the browser's memory or CPU" — batch
  needs an explicit queue/concurrency-limit policy (almost certainly
  sequential-by-default given this is a memory-bound in-browser pipeline,
  with the exact concurrency ceiling a real design decision, not an
  assumption to make silently).
- **Progress/results UI:** every current results component
  (`ToolStatus`, `STLRepairResult`, etc.) assumes one file's status/result
  at a time. Batch needs an aggregated progress view (N of M complete,
  per-file success/failure) and a way to download N results (a zip
  bundle, most likely, which would be new code — nothing in `src/lib/`
  currently zips arbitrary output files together; `src/lib/threemf/`'s
  ZIP handling is 3MF-package-specific, not a general-purpose archiver).
- **Verification discipline:** Phase 6 established that every repair must
  reparse and re-diagnose its own actual output before claiming success.
  A batch repair run must preserve this per-file, not average it away
  into one aggregate "N succeeded" claim that hides which specific files
  didn't actually verify clean.
- **Reusable presets:** mentioned in Pro copy ("reusable repair presets")
  but `RepairSettings` currently has no persistence layer at all (by
  design — no localStorage/database per the privacy promise). Presets
  would need an explicit, disclosed storage decision (most plausibly
  browser `localStorage`, scoped and documented, still fully local) before
  any code exists.

**None of this is designed yet, let alone built.** This is a genuine
multi-phase architecture project, not an incremental add-on to the
current single-file pipelines.

## 6. What payment/licensing decision remains unresolved

Every part of it: payment processor choice (Stripe, Paddle, LemonSqueezy,
etc. — none evaluated), license enforcement model (a license key checked
client-side has no real enforcement without a server; a server introduces
exactly the backend/account infrastructure the product's entire privacy
positioning has avoided so far — this tension is itself undecided), how a
license would activate Pro features in a codebase with zero account
system, and what "lifetime license" fulfillment/delivery looks like
without any account to attach it to. **This is a strategic product
decision, not an engineering task** — no amount of additional code review
resolves it; it needs an explicit decision from the product owner before
any implementation starts.

## 7. Whether the current uncommitted working tree can be reproduced safely

**Dependency graph: yes.** `npm ci --dry-run` reports the lockfile is in
sync with `package.json` (`"up to date"`) — a fresh `npm ci` would
reproduce `node_modules` exactly. `.gitignore` correctly excludes
`node_modules/`, `dist/`, `.astro/`, and no `.env`/secret files exist
anywhere in the tree.

**Source code: no — this is the audit's most serious finding.** The
repository's only commit (`789ed7c`, "Phase 3 complete") contains **202
files**. The current working tree contains **390** (excluding
`node_modules`/`dist`) — nearly double. **Every line of Phase 4A–4F (all
four additional viewers plus the Universal Viewer), Phase 5 (STL
Diagnostics), Phase 6 (STL Repair), and Phase 7 (the SEO audit tooling
and every fix it made) exists only on this one machine's disk, in an
uncommitted state.** If this working directory were lost, corrupted, or
this machine became unavailable, all of that work would need to be
rebuilt from scratch — there is no git history, branch, tag, or bundle
capturing any of it.

This is unrelated to (and more urgent than) the domain-configuration
blocker. **Recommendation, not executed by this audit per its own
instructions (no commits):** commit the current working tree in
logical, phase-sized chunks at the next opportunity the user explicitly
requests it. This audit does not commit anything itself.

## Release gate (run for this audit)

```text
npm run check   → 0 errors, 0 warnings, 0 hints (372 files)
npm run test    → 1,212 tests passed across 96 files, 0 failed
npm run build   → 20 pages built, sitemap + robots.txt generated, 55 CSP hashes
npm run seo:audit → 43 critical issues, 0 warnings — ALL 43 trace to the
                     single deferred domain blocker (per this audit's own
                     instructions, not addressed here); 0 non-domain
                     critical issues
```

## Go / no-go verdict

**No-go for Pro or batch work. Conditional go for Phase 8, with a
stabilization item strongly recommended first.**

Reasoning: the codebase's engineering quality is high and well-tested
(1,212 passing tests, clean type-check, clean build, a working non-domain
SEO posture), but two things block anything beyond continued free-tool
development:

1. **Pro has no architecture and no resolved business decision behind
   it** (sections 3, 5, 6) — building batch infrastructure or payment
   integration now would mean guessing at product/business decisions that
   aren't this codebase's to make.
2. **Nearly half the project's work is uncommitted** (section 7) — this
   is a standing risk regardless of which feature work comes next, and
   ideally gets addressed (a commit, at the user's explicit request)
   before a large amount of *additional* uncommitted work (a full Phase 8)
   piles on top of it.

### Recommendation ranking

1. **Prerequisite stabilization pass** (recommended first, even though
   it's mostly "ask the user to commit," not new engineering): get the
   working tree committed in reviewable chunks, and consider the two
   small honesty fixes this audit surfaced (the `Offer`/`availability`
   structured-data gap in section 4; optionally a fresh live smoke pass on
   the 12 not-recently-re-verified tools from section 1). Low effort,
   removes real risk, no product decisions required.
2. **Phase 8 (STL Optimization)** next — it's already scoped, fits the
   established single-file architecture without requiring new
   infrastructure decisions, and continues the free-tool roadmap in a
   codebase that's demonstrably ready for it (clean gate, established
   patterns, a real handoff prompt already written).
3. **Payment/licensing architecture** — defer until the product owner
   makes the strategic decisions in section 6; premature engineering here
   would likely need to be redone once those decisions land.
4. **Pro batch infrastructure** — defer for the same reason as #3, and
   because it depends on #3's outcome (a license/entitlement model needs
   to exist before "batch is a Pro feature" can be enforced or even
   meaningfully offered).

This audit added no features, fixed no bugs, made no commits, and did not
touch domain configuration, per its own scope.
