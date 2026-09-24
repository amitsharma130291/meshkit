# SEO page inventory (Phase 7)

Authoritative inventory of every route MeshWrench's static build produces,
generated from three sources kept intentionally in sync and cross-checked
by tests/the audit script rather than trusted blindly against each other:

1. **Astro routes** — `src/pages/**/index.astro` (+ `src/pages/robots.txt.ts`).
2. **The tool registry** — `src/config/tools.ts`.
3. **Production output** — `dist/**/*.html`, `dist/sitemap-*.xml`, `dist/robots.txt`,
   inspected by `scripts/audit-seo.mjs` after every build.

The manifest this table mirrors lives in code at
`scripts/seo-audit/route-manifest.mjs`; `scripts/seo-audit/route-manifest.test.ts`
(via `route-manifest.test.mjs`) cross-checks its pathname set against the
real `src/pages/*/index.astro` glob on every test run, so this document and
the manifest it's generated from can't silently drift from the actual
built routes. Titles, descriptions, H1s and structured-data types below
are taken directly from a real `npm run build` + `npm run seo:audit` run's
`dist/seo-audit.json` output — not hand-typed.

**Total: 20 built routes.** 18 indexable, 1 development-only
(`/foundation-preview/`), 1 canonical-alias with no page of its own
(`/online-stl-viewer/`, a static 301 redirect — see
`docs/ARCHITECTURE.md`'s "Route strategy" section).

## Classification legend

| Classification | Meaning |
| --- | --- |
| `indexable-primary` | A tool's main, canonical route — the one search should rank for its core intent. |
| `indexable-intent-page` | A distinct-intent secondary route for a tool that already has a primary route elsewhere, with genuinely differentiated copy (never a duplicate). |
| `canonical-alias` | No Astro page of its own — a real HTTP 301 redirect to another route, to capture a search intent without duplicate content. |
| `noindex-utility` | A built page, intentionally excluded from search (none currently — reserved for a future utility page like an account/settings screen). |
| `development-only` | An internal/architecture-proof page, never public. |

## Route table

| Pathname | Type | Primary intent | Title | H1 | Structured data | Sitemap | Related tools (registry) | Tool status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | indexable-primary | brand / directory entry point | MeshWrench — Private 3D File Tools | "Your 3D files, fixed in your browser." | WebApplication | yes | all ready tools (registry-driven) | n/a |
| `/stl-viewer/` | indexable-primary | view an STL file online | STL Viewer — Open and Inspect STL Files Online \| MeshWrench | STL Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 16 (see registry) | ready |
| `/obj-viewer/` | indexable-primary | view an OBJ file online | OBJ Viewer — Open and Inspect OBJ Files Online \| MeshWrench | OBJ Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 7 | ready |
| `/3mf-viewer/` | indexable-primary | view a 3MF file online | 3MF Viewer — Open and Inspect 3MF Files Online \| MeshWrench | 3MF Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 7 | ready |
| `/glb-viewer/` | indexable-primary | view a GLB file online | GLB Viewer — Open and Inspect GLB Files Online \| MeshWrench | GLB Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 7 | ready |
| `/ply-viewer/` | indexable-primary | view a PLY file online | PLY Viewer — Open and Inspect PLY Files Online \| MeshWrench | PLY Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 7 | ready |
| `/fbx-viewer/` | indexable-primary | view a binary FBX file online | FBX Viewer — Open and Inspect Binary FBX Files Online \| MeshWrench | FBX Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 6 | ready |
| `/viewer/` | indexable-primary | open any supported 3D format in one viewer | 3D File Viewer — STL, OBJ, 3MF, GLB, PLY & FBX Online \| MeshWrench | 3D File Viewer | BreadcrumbList, FAQPage, WebApplication | yes | 8 | ready |
| `/3mf-to-stl/` | indexable-primary | convert 3MF to STL | 3MF to STL Converter — Convert 3MF Files Online \| MeshWrench | 3MF to STL Converter | BreadcrumbList, FAQPage, WebApplication | yes | 2 | ready |
| `/obj-to-stl/` | indexable-primary | convert OBJ to STL | OBJ to STL Converter — Convert OBJ Files Online \| MeshWrench | OBJ to STL Converter | BreadcrumbList, FAQPage, WebApplication | yes | 2 | ready |
| `/glb-to-stl/` | indexable-primary | convert GLB to STL | GLB to STL Converter — Convert GLB Files Online \| MeshWrench | GLB to STL Converter | BreadcrumbList, FAQPage, WebApplication | yes | 2 | ready |
| `/ply-to-stl/` | indexable-primary | convert PLY to STL | PLY to STL Converter — Convert PLY Files Online \| MeshWrench | PLY to STL Converter | BreadcrumbList, FAQPage, WebApplication | yes | 2 | ready |
| `/stl-to-obj/` | indexable-primary | convert STL to OBJ | STL to OBJ Converter — Convert STL Files Online \| MeshWrench | STL to OBJ Converter | BreadcrumbList, FAQPage, WebApplication | yes | 1 | ready |
| `/stl-to-3mf/` | indexable-primary | convert STL to 3MF | STL to 3MF Converter — Convert STL Files Online \| MeshWrench | STL to 3MF Converter | BreadcrumbList, FAQPage, WebApplication | yes | 1 | ready |
| `/stl-checker/` | indexable-primary | check (diagnose, don't fix) an STL | STL Checker — Check STL Files for Holes & Errors Online \| MeshWrench | STL Checker | BreadcrumbList, FAQPage, WebApplication | yes | 6 | ready |
| `/stl-validator/` | indexable-intent-page | validate STL watertightness against a disclosed rule set | STL Validator — Validate STL Files for Manifold Errors \| MeshWrench | STL Validator | BreadcrumbList, FAQPage, WebApplication | yes | 5 | ready |
| `/stl-repair/` | indexable-primary | repair (fix, not just detect) an STL | STL Repair — Fix Holes, Normals & Non-Manifold STL Files \| MeshWrench | STL Repair | BreadcrumbList, FAQPage, WebApplication | yes | 6 | ready |
| `/make-stl-watertight/` | indexable-intent-page | close holes / make an STL watertight | Make STL Watertight — Close Holes in STL Files Online \| MeshWrench | Make STL Watertight | BreadcrumbList, FAQPage, WebApplication | yes | 4 | ready |
| `/repair-non-manifold-stl/` | indexable-intent-page | fix non-manifold edges in an STL | Repair Non-Manifold STL — Fix Non-Manifold Edges Online \| MeshWrench | Repair Non-Manifold STL | BreadcrumbList, FAQPage, WebApplication | yes | 4 | ready |
| `/online-stl-viewer/` | canonical-alias | same intent as `/stl-viewer/` | — (301 redirect, no page) | — | — | no | — | n/a |
| `/foundation-preview/` | development-only | internal architecture proof | Foundation Preview (internal) \| MeshWrench | Foundation preview | none | no | — | n/a |

Every indexable route's canonical URL is self-referential (its own path,
not a shared/parent path) and every meta description is unique — verified
by `scripts/audit-seo.mjs`'s uniqueness and canonical-agreement checks,
which fail the audit on any duplicate or mismatch.

## Cannibalization review (required pairs)

Each pair below was reviewed for genuinely distinct intent, not just a
distinct URL:

- **STL Viewer vs. Universal Viewer** — STL Viewer targets "open an STL
  file" specifically (STL-only search intent, simpler single-format
  copy); the Universal Viewer targets "I have a 3D file, I don't know/care
  which viewer" (format-agnostic intent, explicitly lists all six
  supported formats). Distinct queries, distinct H1s, distinct FAQ sets.
- **STL Checker vs. STL Validator** — Checker targets "check/detect
  problems in my STL" (diagnostic, exploratory framing); Validator targets
  "validate against a rule set" (pass/fail, compliance framing) — same
  underlying analysis, deliberately different search intent and framed
  differently on-page (see `docs/ARCHITECTURE.md`'s STL Diagnostics
  section for the shared-implementation rationale).
- **STL Checker vs. STL Repair** — Checker never mutates or offers a
  download; Repair's entire value proposition is producing a new file.
  Checker's own "What's next: STL Repair" section links forward into the
  repair funnel rather than duplicating repair's content.
- **STL Repair vs. Make STL Watertight** — Repair covers the full
  operation set (holes, winding, duplicates, non-manifold, welding);
  Make STL Watertight narrows to the hole-filling/boundary-gap subset and
  targets the specific "watertight" search phrase slicers themselves use
  in their own error messages.
- **STL Repair vs. Repair Non-Manifold STL** — same relationship, narrowed
  to the non-manifold-edge subset and that specific error-message phrase.
- **Format viewers vs. format converters** (e.g. OBJ Viewer vs. OBJ to
  STL) — "view/inspect" intent vs. "convert to STL" intent are different
  enough queries that Google's own keyword-intent classification treats
  them as distinct; each pair's related-tools section cross-links the
  other rather than merging them.

## Known, accepted exception

`/stl-repair/`, `/make-stl-watertight/` and `/repair-non-manifold-stl/`
each render their own "Related tools" section with hand-written markup
duplicated per page (a pattern several other tool-family pages also use),
rather than all sharing the new `src/components/tools/RelatedTools.astro`
component this phase introduced. `/stl-viewer/` was migrated to the shared
component in this phase because it had a real bug (every related tool was
hardcoded as unlinked "Planned" text, even after several shipped) —
consolidating the remaining pages onto the shared component is a
documented, low-risk follow-up, not a defect: every other page's own
unconditional-link pattern is safe today because none of their currently
related tools are unbuilt (verified by the `relatedToolIds`-reciprocity
test in `src/config/tools.test.ts`, which would fail immediately if that
ever changed).
