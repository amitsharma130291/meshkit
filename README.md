# MeshWrench

MeshWrench is a privacy-first, browser-based toolkit for viewing, converting,
diagnosing, repairing and optimizing 3D files. Every tool runs entirely on
the visitor's device — a file's bytes are never uploaded, and there is no
file-processing backend, account system or database.

**Current status: Phase 10 complete — Pro Feature Set (batch
processing).** A strictly test-first entitlement interface
(`src/lib/pro/`) and batch-processing infrastructure (`src/lib/batch/`)
power multi-file batch processing, wired live into all eight batch-capable
routes — conversion (3MF/OBJ/GLB/PLY→STL, STL→OBJ, STL→3MF), STL Repair
and STL Optimization, each with a plan-before-mutation workflow (file
intake → analyze/plan → confirm and run) for repair/optimization, saved
presets, adjustable concurrency (1–2 files at once) and JSON/ZIP batch
reports — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s "Pro Feature
Set (Phase 10)" section for the full architecture. **Production always
resolves Free** — Pro purchase activation is not available until Phase 11
(Dodo Payments); no bypass exists client-side, verified at both the source
and built-bundle level. Entitlement is always explicit dependency
injection (`createProductionEntitlementProvider()` in production,
`createTestEntitlementProvider(...)` in tests/verification harnesses) —
there is no URL-, storage- or global-based unlock mechanism anywhere.

Phase 9 (G-code Cluster) is complete: a from-scratch, strictly
test-first G-code engine (`src/lib/gcode/`, 22 modules, ~340+ tests)
powers five viewer/visualizer/simulator routes sharing one
parser/worker/renderer/client — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s "G-code Cluster (Phase 9)"
section for the full architecture, the documented modal-state policy,
the arc chord-error/subdivision policy, and dialect/layer-inference
rules. This is a static viewer/visualizer/visual-simulator only — it
never executes G-code, never uses WebSerial, and never connects to a
printer. The homepage, seven production converters/viewer from Phase
3, all six Phase 4 viewers, STL Diagnostics, STL Repair, STL
Optimization, and the G-code Cluster are live:
[`/stl-viewer/`](src/pages/stl-viewer/index.astro)
(Phase 2), [`/3mf-to-stl/`](src/pages/3mf-to-stl/index.astro) (Phase 3A),
[`/obj-to-stl/`](src/pages/obj-to-stl/index.astro) (Phase 3B),
[`/glb-to-stl/`](src/pages/glb-to-stl/index.astro) (Phase 3C),
[`/stl-to-obj/`](src/pages/stl-to-obj/index.astro) (Phase 3D),
[`/stl-to-3mf/`](src/pages/stl-to-3mf/index.astro) (Phase 3E),
[`/ply-to-stl/`](src/pages/ply-to-stl/index.astro) (Phase 3F),
[`/obj-viewer/`](src/pages/obj-viewer/index.astro) (Phase 4A),
[`/3mf-viewer/`](src/pages/3mf-viewer/index.astro) (Phase 4B),
[`/glb-viewer/`](src/pages/glb-viewer/index.astro) (Phase 4C),
[`/ply-viewer/`](src/pages/ply-viewer/index.astro) (Phase 4D),
[`/fbx-viewer/`](src/pages/fbx-viewer/index.astro) (Phase 4E),
[`/viewer/`](src/pages/viewer/index.astro) (Phase 4F),
[`/stl-checker/`](src/pages/stl-checker/index.astro) /
[`/stl-validator/`](src/pages/stl-validator/index.astro) (Phase 5),
[`/stl-repair/`](src/pages/stl-repair/index.astro) /
[`/make-stl-watertight/`](src/pages/make-stl-watertight/index.astro) /
[`/repair-non-manifold-stl/`](src/pages/repair-non-manifold-stl/index.astro)
(Phase 6), and
[`/reduce-stl-file-size/`](src/pages/reduce-stl-file-size/index.astro) /
[`/simplify-stl/`](src/pages/simplify-stl/index.astro) /
[`/stl-triangle-reducer/`](src/pages/stl-triangle-reducer/index.astro)
(Phase 8), and
[`/gcode-viewer/`](src/pages/gcode-viewer/index.astro) /
[`/gcode-visualizer/`](src/pages/gcode-visualizer/index.astro) /
[`/gcode-simulator/`](src/pages/gcode-simulator/index.astro) /
[`/gcode-layer-viewer/`](src/pages/gcode-layer-viewer/index.astro) /
[`/gcode-toolpath-viewer/`](src/pages/gcode-toolpath-viewer/index.astro)
(Phase 9) — all six planned Phase 3 converters, all six planned Phase 4
viewers, the first Phase 5 diagnostic tool, the first Phase 6 repair
tool, the first Phase 8 optimization tool, and all five Phase 9 G-code
tools. All twenty-six pages are built on the same Phase 1 foundation —
SEO/layout infrastructure, local file intake, a Web Worker protocol, a
WASM loader and a Three.js viewport. `/foundation-preview/` remains as a
non-public technical proof of the underlying pipeline. The FBX Viewer was
the first Phase 4 viewer with no pre-existing MeshWrench parser to reuse —
`src/lib/fbx/` is a brand-new, from-scratch binary FBX 7.x reader, built
and tested the same way every earlier format's reader was, just without
an existing converter to build on top of this time. The Universal 3D File
Viewer (`/viewer/`) is the opposite kind of phase: it adds no new parsing
code at all — `src/lib/viewer/` is a content-based format-detection and
lazily-loaded adapter layer that dispatches each file to whichever of the
five dedicated viewer pipelines above actually reads that format, reusing
every one of them unchanged. STL Diagnostics (`/stl-checker/` and
`/stl-validator/`, sharing one implementation) is a third kind of phase:
it adds no new *format* parsing either, but does add a genuinely new,
independently-tested, format-neutral triangle-soup topology layer
(`src/lib/mesh/`) — exact-identity vertex canonicalization, edge
incidence, boundary components, connected shells, orientation, duplicate
faces and spatial-grid-accelerated self-intersection testing — that a
`src/lib/stl-diagnostics/` analysis pipeline runs over the existing
`parseSTL()` output to produce a strict, disclosed watertightness
verdict. STL Repair (`/stl-repair/` plus two SEO routes, sharing one
implementation) builds directly on top of that same topology layer: it
adds no new topology definitions of its own, only a conservative,
verified repair pipeline (welding, degenerate/duplicate cleanup, winding
correction, hole filling, small-shell cleanup) that re-parses and
re-diagnoses its own output before ever reporting a repair as successful.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run check   # astro check — type-checks .astro and .ts files
npm run test    # vitest — unit tests for lib/* logic
npm run build   # astro build — static output to dist/, then a postbuild
                 # step (scripts/generate-csp-headers.mjs) hardens dist/_headers
```

The production origin is `https://meshwrench.com`, set once in
`src/config/site-url.ts`'s `PRODUCTION_SITE_URL`. `src/config/site.ts`
reads it for `siteConfig.siteUrl`, and `astro.config.mjs`'s `site` reads
`siteConfig.siteUrl` in turn — one literal value, never duplicated. A
future domain change means updating that single constant;
`validateProductionSiteUrl()` (also in `site-url.ts`) rejects
`example.com`, localhost, HTTP, a `www.` host and other malformed shapes
at build time so a regression fails loudly instead of shipping silently.
`robots.txt` needs no separate edit: it's a dynamic endpoint
(`src/pages/robots.txt.ts`) that reads `siteConfig.siteUrl` directly.
After any change, run `npm run seo:audit` to confirm zero critical
findings — see
[docs/SEO-LAUNCH-CHECKLIST.md](docs/SEO-LAUNCH-CHECKLIST.md).

## Local SEO audit

```bash
npm run seo:audit   # builds, then inspects the real dist/ output for
                     # title/description issues, canonical/sitemap/robots
                     # agreement, structured-data validity, broken
                     # internal links, orphan pages, Open Graph coverage
                     # and unsupported content claims. Writes
                     # dist/seo-audit.json. Exits non-zero on any
                     # critical issue.
```

## Architecture overview

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full
technical writeup: the privacy boundary, the file/worker/WASM/viewport
lifecycles, resource-disposal rules, the STL parser, the 3MF package/ZIP
safety model, OPC relationship resolution, transform composition and
reflected-geometry handling, binary STL serialization, the STL Repair
pipeline (Phase 6), and the recommended Phase 7 (Launch SEO) starting
point. Short version:

```
src/
├── components/
│   ├── seo/        SEOHead.astro, StructuredData.astro
│   ├── site/       SiteHeader.astro, SiteFooter.astro (shared chrome)
│   └── tools/      LocalFilePicker, ToolStatus, ToolViewport, ToolError,
│                    PrivacyNotice, ModelInfoPanel, ViewerControls,
│                    OBJModelInfo, SceneTree, ViewerDisplayControls,
│                    ThreeMFModelInfo, ThreeMFSceneTree, ThreeMFMetadata,
│                    ThreeMFDisplayControls, GLBModelInfo, GLBSceneTree,
│                    GLBMaterialInfo, GLBDisplayControls, PLYModelInfo,
│                    PLYGeometryPanel, PLYDisplayControls, FBXModelInfo,
│                    FBXSceneTree, FBXMaterialPanel, FBXDisplayControls,
│                    UniversalModelInfo, UniversalSceneTree,
│                    UniversalMaterialPanel, UniversalDisplayControls,
│                    STLDiagnosticsSummary, STLDiagnosticsChecks,
│                    STLDiagnosticsDetails, STLDiagnosticsControls,
│                    STLRepairSettings, STLRepairPlan, STLRepairResult,
│                    STLRepairComparison, STLRepairControls,
│                    STLOptimizeSettings, STLOptimizePlan, STLOptimizeResult,
│                    STLOptimizeComparison, STLOptimizeControls, RelatedTools
│                    (Phase 7 — shared "related tools" block, used by
│                    /stl-viewer/ and every Phase 8 optimization route;
│                    see docs/ARCHITECTURE.md's "Launch SEO (Phase 7)"
│                    section for why the older pages' own copies were
│                    deliberately left as-is) —
│                    presentation-only scaffolding each tool page wires up
│                    with its own client script
├── config/         site.ts (product facts), tools.ts (tool registry)
├── layouts/        BaseLayout.astro, ToolLayout.astro
├── lib/
│   ├── files/       validation.ts, file-session.ts, format-types.ts, download.ts
│   ├── workers/      protocol.ts, worker-client.ts
│   ├── wasm/         wasm-loader.ts, wasm-types.ts
│   ├── three/        viewport.ts, disposal.ts
│   ├── stl/           types.ts, detect.ts, parse-binary.ts, parse-ascii.ts,
│   │                   parse.ts, bounds.ts, normals.ts, format.ts, errors.ts,
│   │                   serialize-binary.ts
│   ├── threemf/       types.ts, errors.ts, xml.ts, package.ts, relationships.ts,
│   │                   model-parser.ts, transforms.ts, resolve-scene.ts,
│   │                   units.ts, convert.ts, viewer-types.ts, viewer-colors.ts,
│   │                   viewer-resources.ts, viewer-scene.ts, viewer-formatting.ts
│   │                   (the last five are the Phase 4B viewer layer)
│   ├── obj/           types.ts, errors.ts, tokenizer.ts, indices.ts,
│   │                   triangulate.ts, parser.ts, convert.ts, formatting.ts,
│   │                   viewer-types.ts, viewer-geometry.ts,
│   │                   viewer-formatting.ts (Phase 4A viewer layer)
│   ├── glb/           types.ts, errors.ts, container.ts, schema.ts,
│   │                   accessors.ts, transforms.ts, primitives.ts,
│   │                   resolve-scene.ts, convert.ts, formatting.ts,
│   │                   viewer-types.ts, viewer-resources.ts, viewer-images.ts,
│   │                   viewer-primitives.ts, viewer-scene.ts, viewer-formatting.ts
│   │                   (the last six are the Phase 4C viewer layer)
│   ├── stl-to-obj/    types.ts, errors.ts, convert.ts, formatting.ts
│   ├── stl-to-threemf/ types.ts, errors.ts, convert.ts, formatting.ts
│   ├── ply/           types.ts, errors.ts, scalar-types.ts, header.ts,
│   │                   scalar-reader.ts, ascii-reader.ts, binary-reader.ts,
│   │                   properties.ts, triangulate.ts, parser.ts, convert.ts,
│   │                   formatting.ts, viewer-types.ts, viewer-resources.ts,
│   │                   viewer-scene.ts, viewer-formatting.ts
│   │                   (the last four are the Phase 4D viewer layer)
│   ├── fbx/            types.ts, errors.ts, binary-reader.ts, binary-parser.ts,
│   │                    property-decoder.ts, document.ts, connections.ts,
│   │                    global-settings.ts, transforms.ts, geometry.ts,
│   │                    layer-elements.ts, materials.ts, images.ts,
│   │                    resolve-scene.ts, viewer-types.ts, formatting.ts
│   │                    (Phase 4E — a brand-new binary FBX 7.x reader,
│   │                    built from scratch; see "FBX Viewer (Phase 4E)"
│   │                    below for why this phase has no separate
│   │                    converter/viewer split the way every other format
│   │                    does)
│   ├── viewer/         format-detection.ts, adapter-types.ts,
│   │                    adapter-registry.ts, formatting.ts,
│   │                    adapters/{stl,obj,threemf,glb,ply,fbx}-adapter.ts
│   │                    (Phase 4F — no new parsing code; content-based
│   │                    format detection plus six thin, lazily-loaded
│   │                    adapters dispatching to the five viewer pipelines
│   │                    above, unchanged)
│   ├── mesh/          deduplicate.ts, number-format.ts, triangulate.ts,
│   │                   errors.ts — format-neutral geometry helpers shared
│   │                   by every *writer* (OBJ, 3MF) and, for triangulation,
│   │                   by the OBJ, PLY and FBX *readers* too; also
│   │                   topology-types.ts, canonical-vertices.ts,
│   │                   edge-incidence.ts, connected-components.ts,
│   │                   boundary-components.ts, orientation.ts,
│   │                   duplicate-faces.ts, triangle-intersections.ts,
│   │                   spatial-index.ts (Phase 5 — a format-neutral
│   │                   triangle-soup topology layer, never STL-specific)
│   ├── stl-diagnostics/ types.ts, errors.ts, analyze.ts, verdict.ts,
│   │                   formatting.ts, report.ts, test-fixtures.ts
│   │                   (Phase 5 — the STL-facing analysis pipeline built
│   │                   on `mesh/*` above and the existing `stl/parse.ts`;
│   │                   no new format parsing)
│   ├── stl-repair/     types.ts, errors.ts, weld.ts, cleanup.ts,
│   │                   hole-fill.ts, winding.ts, shell-cleanup.ts,
│   │                   plan.ts, outcome.ts, overlays.ts, repair.ts,
│   │                   formatting.ts, report.ts, test-fixtures.ts
│   │                   (Phase 6 — a conservative repair pipeline built on
│   │                   `mesh/*` and `stl-diagnostics/analyze.ts`, unchanged;
│   │                   no new topology or format parsing of its own)
│   ├── mesh-optimization/ types.ts, errors.ts, quadric.ts, indexed-mesh.ts,
│   │                   collapse-validation.ts, collapse-heap.ts,
│   │                   edge-candidates.ts, simplify.ts, deviation.ts,
│   │                   volume-surface.ts, plan.ts, outcome.ts, optimize.ts,
│   │                   formatting.ts, report.ts, test-fixtures.ts
│   │                   (Phase 8 — a deterministic quadric-error-metric
│   │                   edge-collapse simplifier, built strictly test-first;
│   │                   reuses `mesh/*` and `stl-repair/types.ts`'s own
│   │                   `DiagnosticsSummary` unchanged, no new topology)
│   ├── gcode/         types.ts, errors.ts, chunked-lines.ts, tokenizer.ts,
│   │                   checksum.ts, modal-state.ts, linear-moves.ts,
│   │                   arcs.ts, extrusion.ts, comments.ts, dialect.ts,
│   │                   layers.ts, features.ts, statistics.ts, timing.ts,
│   │                   geometry.ts, playback.ts, analyze.ts, formatting.ts,
│   │                   report.ts, test-fixtures.ts
│   │                   (Phase 9 — a from-scratch G-code parsing/analysis
│   │                   engine, built strictly test-first; not a mesh
│   │                   format, so it shares nothing with `mesh/*`)
│   ├── cancellation.ts shared mid-loop cancellation primitive
│   ├── browser/      capabilities.ts
│   ├── errors.ts     shared ErrorCode vocabulary
│   └── tool-state.ts shared ToolState union
├── workers/         foundation.worker.ts, stl-viewer.worker.ts,
│                     threemf-to-stl.worker.ts, obj-to-stl.worker.ts,
│                     glb-to-stl.worker.ts, stl-to-obj.worker.ts,
│                     stl-to-threemf.worker.ts, ply-to-stl.worker.ts,
│                     obj-viewer.worker.ts, threemf-viewer.worker.ts,
│                     glb-viewer.worker.ts, ply-viewer.worker.ts,
│                     fbx-viewer.worker.ts, stl-diagnostics.worker.ts,
│                     stl-repair.worker.ts, stl-optimizer.worker.ts,
│                     gcode.worker.ts
└── pages/
    ├── index.astro                 the public homepage
    ├── stl-viewer/                 the STL Viewer — index.astro + _client.ts
    ├── 3mf-to-stl/                 the 3MF→STL converter — index.astro + _client.ts
    ├── obj-to-stl/                 the OBJ→STL converter — index.astro + _client.ts
    ├── glb-to-stl/                 the GLB→STL converter — index.astro + _client.ts
    ├── stl-to-obj/                 the STL→OBJ converter — index.astro + _client.ts
    ├── stl-to-3mf/                 the STL→3MF converter — index.astro + _client.ts
    ├── ply-to-stl/                 the PLY→STL converter — index.astro + _client.ts
    ├── obj-viewer/                 the OBJ Viewer (Phase 4A) — index.astro + _client.ts
    ├── 3mf-viewer/                 the 3MF Viewer (Phase 4B) — index.astro + _client.ts
    ├── glb-viewer/                 the GLB Viewer (Phase 4C) — index.astro + _client.ts
    ├── ply-viewer/                 the PLY Viewer (Phase 4D) — index.astro + _client.ts
    ├── fbx-viewer/                 the FBX Viewer (Phase 4E) — index.astro + _client.ts
    ├── viewer/                     the Universal 3D File Viewer (Phase 4F) — index.astro + _client.ts
    ├── stl-checker/                 STL Diagnostics, primary route (Phase 5) — index.astro + _client.ts
    ├── stl-validator/               STL Diagnostics, secondary SEO route (Phase 5) — index.astro only, imports ../stl-checker/_client
    ├── stl-repair/                  STL Repair, primary route (Phase 6) — index.astro + _client.ts
    ├── make-stl-watertight/         STL Repair, secondary SEO route (Phase 6) — index.astro only, imports ../stl-repair/_client
    ├── repair-non-manifold-stl/     STL Repair, secondary SEO route (Phase 6) — index.astro only, imports ../stl-repair/_client
    ├── robots.txt.ts                dynamic endpoint (Phase 7) — derives the Sitemap: line from siteConfig.siteUrl
    ├── reduce-stl-file-size/        STL Optimization, primary route (Phase 8) — index.astro + _client.ts
    ├── simplify-stl/                STL Optimization, secondary SEO route (Phase 8) — index.astro only, imports ../reduce-stl-file-size/_client
    ├── stl-triangle-reducer/        STL Optimization, secondary SEO route (Phase 8) — index.astro only, imports ../reduce-stl-file-size/_client
    ├── gcode-viewer/                G-code Cluster, primary route (Phase 9) — index.astro + _client.ts
    ├── gcode-visualizer/            G-code Cluster, secondary SEO route (Phase 9) — index.astro only, imports ../gcode-viewer/_client
    ├── gcode-simulator/             G-code Cluster, secondary SEO route (Phase 9) — index.astro only, imports ../gcode-viewer/_client
    ├── gcode-layer-viewer/          G-code Cluster, secondary SEO route (Phase 9) — index.astro only, imports ../gcode-viewer/_client
    ├── gcode-toolpath-viewer/       G-code Cluster, secondary SEO route (Phase 9) — index.astro only, imports ../gcode-viewer/_client
    └── foundation-preview/         internal, noindex, proves the architecture

scripts/
├── generate-csp-headers.mjs     postbuild — hashes every JSON-LD block into dist/_headers' CSP
├── generate-foundation-wasm.mjs  builds the Phase 1 foundation-preview test WASM module
├── audit-seo.mjs                Phase 7 — `npm run seo:audit` entry point; builds, then audits dist/
└── seo-audit/                   Phase 7 — pure, independently unit-tested audit modules:
                                   route-manifest.mjs, url-utils.mjs, html-utils.mjs, checks.mjs,
                                   sitewide-checks.mjs, content-accuracy.mjs (each with a colocated
                                   *.test.mjs, picked up by vitest.config.ts's "scripts/**/*.test.mjs")
```

`src/lib/obj/` holds both the OBJ *reader* (Phase 3B: `tokenizer.ts`,
`indices.ts`, `triangulate.ts`, `parser.ts`, `convert.ts`) and the OBJ
*writer* (Phase 3D: `serialize.ts`, plus thin compatibility wrappers
around `src/lib/mesh/`'s `deduplicate.ts`/`number-format.ts`), sharing
one `errors.ts` between both directions — the same pattern
`src/lib/stl/` already uses for its own reader/writer split.
`src/lib/threemf/` similarly holds both the 3MF reader (Phase 3A) and
writer (Phase 3E: `model-writer.ts`, `package-writer.ts`, `xml-escape.ts`),
sharing that directory's own `errors.ts`. `src/lib/mesh/` (added in
Phase 3E, extended in Phase 3F) is the canonical, format-neutral home for
exact vertex deduplication, float32 text formatting and polygon
triangulation — used by both writers and, for triangulation, by both the
OBJ and PLY readers — with `src/lib/obj/`'s own copies of these files
(and the new `src/lib/ply/triangulate.ts`) now thin wrappers preserving
each domain's own exact error codes. `src/lib/stl/degenerate.ts` (also
Phase 3E) is the shared home for degenerate-triangle filtering, used
identically by both the OBJ and 3MF writers.

`src/lib/obj/viewer-geometry.ts` (Phase 4A) is a second orchestration layer
over the OBJ reader, not a second parser: it runs its own single forward
pass (required for the same negative-index reason `parseOBJDocument` is
single-pass) but built entirely from primitives imported from
`parser.ts`/`indices.ts`/`tokenizer.ts`/`triangulate.ts` — vertex/face
validation, index resolution and polygon triangulation are byte-identical
to the converter's own. It adds only what a viewer needs and a converter
discards: actual `vn` values (not just syntax validation), per-face-corner
normal references, object/group/material/smoothing-group segmentation, and
resolved `l`/`p` line/point geometry. `viewer-types.ts` holds its result
and safety-ceiling types; `viewer-formatting.ts` holds its display-only
name-sanitization and label helpers. `src/workers/obj-viewer.worker.ts`
runs this pipeline and ends at an `OBJViewerResult` — unlike
`obj-to-stl.worker.ts`, it never calls `serializeBinarySTL()`, since a
viewer produces no downloadable file.

`src/lib/threemf/viewer-resources.ts`/`viewer-scene.ts` (Phase 4B) follow
the identical pattern one directory over: `viewer-resources.ts` runs its
own `XMLHandler` over the same shared `parseXML()` tokenizer (never a
second XML/ZIP reader) to capture what `parseThreeMFModel()` (the
converter's own parser) discards — object/build-item `name`, per-object
and per-triangle color-property references (`pid`/`pindex`/`p1`/`p2`/`p3`),
actual `<basematerials>`/`<colorgroup>` contents, `<metadata>` text (which
required one small additive change to `xml.ts` itself: an optional
`onText` callback on `XMLHandler`, since text content was previously
discarded entirely and no existing caller uses it), and
production-extension cross-part references. `viewer-scene.ts` then walks
Build → build item → component instance → ... → mesh object exactly like
`resolveScene()` — same cycle detection, same depth ceiling, same instance
ceiling, same transform composition order (reused directly from
`transforms.ts`), same reflected-winding fix, same once-only unit
conversion (reused directly from `units.ts`) — but also records one
`ThreeMFViewerSegment` per mesh-leaf visit and resolves a per-corner color
for every triangle, using `viewer-colors.ts`'s hex parsing, sRGB→linear
conversion and (pid, pindex) resolution. `src/workers/threemf-viewer.worker.ts`
mirrors `threemf-to-stl.worker.ts`'s stage shape but ends at a
`ThreeMFViewerResult`, never calling `serializeBinarySTL()`.

`src/lib/glb/viewer-*.ts` (Phase 4C) follow the same pattern a third time,
adapted to glTF's own richer JSON: `schema.ts` already parses node/mesh/
scene names, morph-target presence and `TEXCOORD_n` attribute keys (the
converter's geometry path happens to need those too), so
`viewer-resources.ts`'s second JSON pass is narrower than 3MF's — it only
adds `materials`/`textures`/`images`/`samplers` and each accessor's
`normalized` flag, the handful of fields `schema.ts` genuinely never
reads. `viewer-primitives.ts` decodes NORMAL/TANGENT/TEXCOORD_0/COLOR_0
values (reusing `readAccessorRaw()` — the converter's own primitive only
reads POSITION and indices) and expands POINTS/LINES/LINE_LOOP/LINE_STRIP
into renderable geometry the converter skips outright, computing a smooth
per-primitive fallback normal (face-normal averaging) whenever a
primitive's `NORMAL` accessor is absent or invalid. `viewer-scene.ts`
walks the node graph exactly like `resolveGLBScene()` — same
`selectRootNodeIndices()`/`localMatrixForNode()` reuse, same cycle/depth/
instance ceilings, same reflected-transform detection via
`determinantSign3x3()` — but keeps source *meter* coordinates (never the
converter's ×1000 millimetre scale) and transforms normals with the
mathematically correct inverse-transpose of the world matrix's linear
part (handling non-uniform scale and reflection alike), not the naive
world matrix. `viewer-images.ts` extracts embedded image bytes via the
exact same `resolveBufferView()` the converter's own accessors use —
still-encoded bytes only; decoding happens on the main thread (see
"Embedded images and main-thread decoding" below), never in this worker.

`src/lib/ply/viewer-resources.ts`/`viewer-scene.ts` (Phase 4D) follow the
same "second orchestration layer, not a second parser" pattern a fourth
time, but PLY's own shape is flatter than the other three formats — no
scene graph, no transforms, no per-instance segments, just one shared,
untransformed vertex array. `viewer-resources.ts` reuses
`parsePLYHeader()`/`findVertexElement()`/`findVertexCoordinates()`/
`findFaceElement()`/`findFaceIndexProperty()`/`countUnknownFaceProperties()`
unchanged — the exact functions the converter's own `resolvePLYSchema()`
uses — but makes the `face` element optional (a point-cloud-only file is a
valid, complete viewer input; the converter correctly rejects it, since
STL can't represent points) and additionally resolves vertex color/
normal/UV property indices plus a conventional `edge` element (only the
`vertex1`/`vertex2` integer layout is recognized; anything else is
skipped with a warning, never guessed at). `viewer-scene.ts` reuses
`tokenizeAsciiBody`/`createAsciiScalarReader`/`createBinaryScalarReader`/
`readListValues`/`skipProperty`/`triangulatePolygon` from the converter's
own reader in one forward pass, adding: actual color/normal/UV values
(not just presence detection), per-vertex (not per-primitive, since PLY
has no primitives) normal fallback — each vertex independently uses its
own valid source normal or an averaged geometric fallback — and edge
index-pair reading. Because every render category (surface/edges/points)
draws from the *same* position array, "fit visible" needs only a bounds
subset per category (`boundsSurface`/`boundsEdges`/`boundsPoints`,
computed by iterating just that category's index set) rather than the
combined-bounds union GLB's viewer needs when categories are
independently transformed. `src/workers/ply-viewer.worker.ts` mirrors
`ply-to-stl.worker.ts`'s own stage names (vertex/face reading and
triangulation are genuinely one interleaved pass here too, not three
separable stages) and ends at a `PLYViewerResult`, never calling
`serializeBinarySTL()`.

`src/lib/fbx/` (Phase 4E) is the first Phase 4 viewer with no existing
MeshWrench parser to build a second orchestration layer over — there is no
`ply-to-stl`-style converter for FBX, so this phase is a from-scratch
binary FBX 7.x reader, layered deliberately: `binary-reader.ts` (a
bounds-checked cursor — the single choke point every read goes through)
→ `binary-parser.ts` (the node-record tree, magic/version validation,
explicit ASCII rejection, the 32-bit/64-bit record-field switch at
version 7500, an *iterative* work-stack walk rather than JS recursion so
a pathological tree depth fails via this module's own ceiling instead of
a native stack overflow) → `property-decoder.ts` (all 13 property type
codes, including zlib-compressed typed arrays via `fflate`'s
`unzlibSync`, with a ceiling checked *before* allocating the decompressed
output buffer) → `document.ts`/`connections.ts` (interprets `Objects`/
`Connections` into typed objects and a validated Model hierarchy —
order-independent, cycle-rejecting, depth-bounded) → `global-settings.ts`
(axis/unit declarations, `null` rather than a guessed default when
incomplete or contradictory) → `transforms.ts` (the FBX SDK's own
documented node-transform formula, including the post-rotation-inversion
and geometric-transform-never-inherited gotchas — see "FBX Viewer (Phase
4E)" below) → `geometry.ts` (polygon decode/triangulation, reusing
`src/lib/mesh/triangulate.ts` unchanged) → `layer-elements.ts` (one
shared mapping-mode/reference-mode resolver for normals/UVs/colors/
materials) → `materials.ts`/`images.ts` (Lambert/Phong properties,
embedded-texture bytes) → `resolve-scene.ts` (orchestrates all of the
above into the final viewer result). `src/workers/fbx-viewer.worker.ts`
reports progress at each of these real stage boundaries and ends at an
`FBXViewerResult` — there is no `serializeBinarySTL()` step for this
phase to skip, since there is no FBX→STL converter in MeshWrench at all.

`src/lib/viewer/` (Phase 4F) is the opposite kind of phase: it adds no
new geometry-reading code at all. `format-detection.ts` classifies a
file from its actual bytes — never its extension — reusing each
format's own existing production validator (`stl/detect.ts`'s binary-
length formula and ASCII-STL heuristic, `threemf/package.ts`'s ZIP
central-directory reader plus `threemf/relationships.ts`'s real OPC
relationship resolution, PLY/GLB/FBX's own documented magic bytes) in a
fixed, most-distinctive-first order, rather than a second, possibly-
diverging sniffing implementation. `adapter-registry.ts` exposes one
`Record<DetectedFormat, () => Promise<ViewerAdapterModule>>` where every
entry is a genuine dynamic `import()`, so selecting a file only ever
downloads that one format's `adapters/*-adapter.ts` plus its worker —
confirmed against both dev-server network requests and the production
build's per-chunk output. Each adapter wraps exactly one of the five
existing dedicated-viewer workers unchanged, imports that worker's own
real result type instead of a hand-duplicated approximation, and owns
its own module-scoped Three.js scene state — the same shape every
dedicated page's own `_client.ts` already uses — so `src/pages/viewer/`'s
`_client.ts` stays a genuine dispatcher (detect → load an adapter → run
its worker → call its `buildScene`/`disposeScene`) around one shared
viewport, rather than six branches copied into one file. See "Universal
3D File Viewer (Phase 4F)" in `docs/ARCHITECTURE.md` for the full
detection-order table, the adapter contract, and a real worker-reuse bug
this phase found and fixed during its own browser verification.

STL Diagnostics (Phase 5 — `/stl-checker/` and `/stl-validator/`, one
shared implementation) adds no new format parsing either, but does add a
genuinely new, independently-tested layer: `src/lib/mesh/` is a
format-neutral triangle-soup topology model built on top of the
existing `deduplicate.ts` (exact float32 vertex identity, never
tolerance-welded), plus seven new modules — edge incidence with
orthogonal manifold/winding-conflict classification, boundary-component
classification (closed loop / open chain / branched / non-simple, never
a bare edge count), iterative union-find shell resolution, BFS-parity
orientation with translation-invariant signed volume, canonical-rotation
duplicate-face detection, and spatial-grid-accelerated self-intersection
testing (a Möller-style narrow phase, never all-pairs O(n²)).
`src/lib/stl-diagnostics/analyze.ts` runs this topology layer over the
existing `parseSTL()` output and assembles a strict, disclosed watertight
verdict (`verdict.ts`) plus a separate, disclaimer-accompanied slicer-risk
summary — never an opaque numeric score. `src/pages/stl-checker/_client.ts`
follows the same single-persistent-worker pattern every dedicated viewer
page already uses (never the Universal Viewer's per-format worker-reuse
pattern), which structurally avoids that phase's own stale-callback bug
class rather than merely avoiding it by convention. See "STL Diagnostics
(Phase 5)" in `docs/ARCHITECTURE.md` for the full per-module design, the
watertight policy, and two real bugs this phase found and fixed in its
own test suite before merge.

STL Repair (Phase 6 — `/stl-repair/`, `/make-stl-watertight/` and
`/repair-non-manifold-stl/`, one shared implementation) adds no new
topology definitions at all: it is a conservative repair pipeline built
directly on Phase 5's own `src/lib/mesh/*` and
`stl-diagnostics/analyze.ts`, unchanged, plus two small additive fields
those modules gained (a boundary component's own edge list; a shell's
per-triangle orientation parity) for data the repair path genuinely
needed. `src/lib/stl-repair/` covers exact and tolerance-based vertex
welding (deterministic spatial-hash clustering, never averaged
positions), degenerate/duplicate-face cleanup, single-pass winding
correction, hole filling restricted to closed-simple boundary loops only,
optional small-shell cleanup, and honest outcome determination
(`fully-repaired` / `improved` / `unchanged` / `partially-repaired` /
`unable-to-repair-safely` / `failed` / `cancelled`). Every repair
serializes a real binary STL, re-parses those exact bytes with the
unchanged `parseSTL()`, and re-runs the unchanged
`analyzeSTLDiagnostics()` before any outcome is reported — a repair is
never declared successful based on the attempted operations alone. Three
presets (Safe, Standard, Custom) share one settings contract; there is no
"aggressive" mode. Self-intersection resolution is detect-only this
phase, and non-manifold edges beyond deterministic duplicate/degenerate
cleanup are left unresolved and reported, never force-fixed by deleting
arbitrary triangles. See "STL Repair (Phase 6)" in
`docs/ARCHITECTURE.md` for the full per-module design, the weld-tolerance
and hole-eligibility policies, and two real pipeline bugs this phase
found and fixed in its own test suite before merge.

STL Optimization (Phase 8 — `/reduce-stl-file-size/`,
`/simplify-stl/` and `/stl-triangle-reducer/`, one shared implementation)
adds a deterministic quadric-error-metric edge-collapse simplifier,
`src/lib/mesh-optimization/`, built strictly test-first (every module's
failing test written and confirmed red before its implementation) and
reusing Phase 5's own `src/lib/mesh/*` topology layer and Phase 6's
`DiagnosticsSummary` unchanged — no new topology definitions. Every
candidate collapse is checked against the manifold link condition,
boundary-loop adjacency (only vertices adjacent on the same closed
boundary loop may collapse together), same-shell membership, a
configurable normal-flip angle, and degenerate/duplicate-triangle guards
before it's ever applied; a local, lazily-invalidated priority queue
means no global rebuild-and-resort after each collapse. Three quality
presets (Preserve details / Balanced / Maximum reduction) share one
settings contract and never disable the underlying safety checks — only
how much detail a collapse may trade away. Every optimization serializes
a real binary STL, re-parses it, and re-runs `analyzeSTLDiagnostics()`
before `outcome.ts` decides anything; `target-achieved` requires the
verified output to meet the resolved target with every safety invariant
holding (shell count unchanged, a watertight input still watertight,
boundary/non-manifold/duplicate counts never increased) — including,
since the Phase 8 closeout, the verified output's own surface-area and
closed-shell volume staying within the active preset's own disclosed
quality-policy threshold (3%/2% for Preserve details, 12%/8% for
Balanced, 35%/25% for Maximum reduction) — exceeding either threshold
caps the outcome to `verification-failed` with an honest reason, never a
false `target-achieved`. An unachievable target is never forced — it
reports the best safely-achieved reduction honestly. Deviation is
measured as a bounded sample (each mesh's own vertices and triangle
centroids checked against the other surface's nearest point) and
explicitly labelled "sampled geometric deviation," never Hausdorff
distance. See "STL Optimization (Phase 8)" and "Surface-area and
closed-shell volume comparison (Phase 8 closeout)" in
`docs/ARCHITECTURE.md` for the full algorithm, the documented boundary/
shell policies, the decision to ship two (not four) secondary SEO routes,
and the real bugs this phase's own tests caught before merge.

## Privacy boundary

- No API route accepts file data — there is no server beyond static
  hosting.
- File bytes reach a Web Worker only via an in-browser transferable
  `ArrayBuffer`, never a network call.
- No file name, content or derived metadata is ever logged in
  production or sent to analytics.
- The 3MF converter's ZIP/XML processing happens entirely inside the
  worker too — no package content ever touches the main thread, let
  alone the network.
- The OBJ converter never fetches a referenced `.mtl` material library
  or any other path found inside the file — parsing, triangulation and
  STL serialization all happen inside its own worker as well.
- The GLB converter never fetches an externally-referenced buffer or
  image — only a GLB's own embedded binary chunk is read, and container
  parsing, glTF JSON validation, scene resolution and STL serialization
  all happen inside its own worker too.
- The STL→OBJ converter reuses the existing STL parser unchanged;
  vertex deduplication and OBJ text serialization both happen inside its
  own worker as well, with no intermediate result ever crossing back to
  the main thread except the final preview arrays and OBJ buffer.
- The STL→3MF converter also reuses the existing STL parser unchanged;
  vertex deduplication, 3MF model-XML generation and ZIP packaging all
  happen inside its own worker, with no intermediate result ever
  crossing back to the main thread except the final preview arrays and
  3MF buffer.
- The PLY converter never fetches anything external — PLY has no notion
  of an external reference in the first place. Header parsing, ASCII/
  binary body reading and STL serialization all happen inside its own
  worker as well.
- The OBJ Viewer never fetches a referenced `.mtl` material library, any
  texture image, or any other path found inside the file — it reports
  `mtllib`/`usemtl` counts and names for information only. Parsing,
  segmentation and line/point geometry assembly all happen inside its own
  worker; the only cross-worker boundary is the final typed arrays and
  bounded metadata.
- The 3MF Viewer never fetches a referenced texture image, another
  package part (a production-extension cross-part component/build-item
  reference), or anything outside the package — embedded colors come only
  from `<basematerials>`/`<colorgroup>` resources already inside the same
  part it already reads for geometry. Package parsing, XML parsing,
  component resolution and color resolution all happen inside its own
  worker; metadata is extracted and bounded there too, and is never
  written into page SEO tags or browser history.
- The GLB Viewer never fetches an external buffer, an external image
  URI, or anything outside the GLB container — only image bytes already
  embedded in the file's own BIN chunk are ever decoded, and only into a
  local `ImageBitmap`/`Blob`, never a network request. Container parsing,
  glTF JSON validation, accessor decoding, scene-graph resolution and
  material/texture/sampler validation all happen inside its own worker;
  image *decoding* is the one deliberate exception to "everything in the
  worker" across all three viewers — see "Embedded images and main-thread
  decoding" below for why.
- The Universal 3D File Viewer never fetches anything external either —
  format detection reads only the already-in-memory `ArrayBuffer`
  (a bounded prefix, or 3MF's ZIP central directory), and dispatch hands
  that same buffer straight to whichever dedicated worker actually reads
  it; the privacy properties above for each individual format's own
  viewer apply completely unchanged when reached through `/viewer/`.
- STL Diagnostics never fetches anything external — the same `parseSTL()`
  already used by every other STL-consuming page reads the file, and
  every topology/analysis stage after that operates purely on the
  already-in-memory geometry inside the worker. The downloadable JSON
  report is generated and offered as a local `Blob` download; it is never
  transmitted anywhere.
- STL Repair never fetches anything external — analysis, planning,
  welding, cleanup, winding correction, hole filling, shell cleanup, and
  re-serialization all happen inside its own worker, on the same
  already-in-memory geometry. The repaired STL and its downloadable JSON
  repair report (which never includes raw triangle coordinates, source
  file bytes, arbitrary STL header text, local file paths, or stack
  traces) are both offered as local `Blob` downloads; neither is ever
  transmitted anywhere.
- STL Optimization never fetches anything external — analysis, the
  edge-collapse loop, serialization, verification and deviation sampling
  all happen inside its own worker. The optimized STL and its
  downloadable JSON report (same exclusions as STL Repair's own report)
  are both offered as local `Blob` downloads; neither is ever transmitted
  anywhere.

### Embedded images and main-thread decoding

`viewer-images.ts` runs inside the worker and only ever extracts and
validates still-*encoded* image bytes (PNG/JPEG) from a bufferView-sourced
`images[]` entry, using the exact bounds-checked `resolveBufferView()` the
converter's own accessor reader uses — an image with a `uri` (external)
is treated as unavailable and never read at all. Actually *decoding*
those bytes into pixels happens on the main thread, in `_client.ts`, via
the browser's own `createImageBitmap()` — a deliberate exception to this
project's "everything happens in the worker" convention, made for two
concrete reasons: Web Workers can construct `ImageBitmap`s too, but the
decoded result still has to cross back to the main thread to become a
Three.js texture regardless of where decoding happens, so decoding in the
worker would only add a second postMessage transfer for no benefit; and
`createImageBitmap` availability itself needs a feature check with a safe
fallback (`typeof createImageBitmap === "function"`), which is simpler to
reason about and test on the main thread where the rest of the viewport
lifecycle already lives. A decode failure (unsupported browser, corrupt
image bytes) never discards otherwise-valid geometry — the model still
renders, with a neutral material standing in for that one texture slot.

## Current limitations

- All six planned Phase 3 converters (3MF/OBJ/GLB/PLY→STL, STL→OBJ/3MF),
  all six planned Phase 4 viewers (STL, OBJ, 3MF, GLB, PLY, binary
  FBX — individually and through the Universal 3D File Viewer), the
  first Phase 5 diagnostic tool (STL Diagnostics), the first Phase 6
  repair tool (STL Repair), the first Phase 8 optimization tool (STL
  Optimization), and all five Phase 9 G-code Cluster tools are complete;
  Phase 7 audited and hardened SEO/crawlability without adding new tool
  functionality; Phase 10 (Pro batch processing) is also complete. See
  "Phase 11 handoff: Dodo Payments and licensing" in
  `docs/ARCHITECTURE.md` for what comes next.
- **The G-code Cluster is a static viewer/visualizer/visual simulator
  only** — it never executes a G-code command, never uses WebSerial, and
  never connects to a printer; playback never claims to exactly
  reproduce physical printer motion. It targets a documented subset of
  common FDM slicer output (Cura, PrusaSlicer, OrcaSlicer, Bambu Studio)
  aimed at Marlin/Klipper-style printers — not universal G-code support.
  Filament-mass calculation was deliberately not built (raw extrusion
  distance only). See "G-code Cluster (Phase 9)", "Known limitations
  (Phase 9)" and "Phase 9 closeout" in `docs/ARCHITECTURE.md`.
- STL Optimization has no visualization overlay buffers (unlike STL
  Repair's own removed/flipped-geometry highlighting). It reports
  surface-area and closed-shell volume before/after (`0` is never shown
  when volume isn't meaningful — the result carries an honest
  `volumeStatus`/`volumeReason` instead), checked against each preset's
  own disclosed surface-area/volume quality-policy thresholds — never a
  manufacturing tolerance. Sharp-feature preservation is a general
  normal-flip angle guard, not a dedicated per-edge sharp-feature
  detection pass. See "Known limitations (Phase 8)" and "Surface-area and
  closed-shell volume comparison (Phase 8 closeout)" in
  `docs/ARCHITECTURE.md`.
- **The production domain is still a placeholder** (`https://example.com`
  in both `astro.config.mjs` and `src/config/site.ts`). Every canonical
  URL, sitemap entry and Open Graph URL is built from this value —
  `npm run seo:audit` reports this loudly as a launch blocker rather than
  shipping it silently. See
  [docs/SEO-LAUNCH-CHECKLIST.md](docs/SEO-LAUNCH-CHECKLIST.md).
- 17 of 18 tool pages still duplicate their own "related tools" markup
  rather than using the shared `RelatedTools.astro` component Phase 7
  introduced — safe today (verified by a standing `relatedToolIds`
  reciprocity test) but a documented consolidation opportunity.
- No local Lighthouse or axe-core run has been added to this project yet;
  the SEO audit's own structural checks cover the automatable subset of
  performance/accessibility signals, not a full Core Web Vitals or WCAG
  scan. See `docs/SEO-LAUNCH-CHECKLIST.md`'s own Performance/Accessibility
  sections for exactly what is and isn't covered.
- STL Repair resolves self-intersections by detection only — an
  unresolved self-intersecting pair is always reported, never
  automatically fixed. Non-manifold edges beyond deterministic
  duplicate/degenerate-face cleanup are left unresolved and reported too;
  no triangle is ever deleted just to force an edge's incidence count to
  two. See "Known limitations (Phase 6)" in `docs/ARCHITECTURE.md` for
  the complete list, including the welding-tolerance/shell-count
  transparency note and the disclosed overlay-attribution simplification.
- The OBJ Viewer derives its "Objects"/"Groups" counts and scene tree from
  triangle-bearing segments only — an `o`/`g` declaration that contains
  only `l`/`p` primitives and no faces doesn't get its own object/group
  entry, even though its line/point geometry still renders and counts
  toward "Line primitives"/"Point primitives". This keeps the scene tree's
  numbers consistent with what it actually lists, at the cost of not
  surfacing a lines-only object's own name.
- The OBJ Viewer's segment-visibility index rebuild and its reader-side
  parse loop share the same limitation `/obj-to-stl/` already has: the
  single-pass parse can only be cancelled between worker stages (reading,
  decoding, parsing, building geometry), not mid-loop inside a single very
  large file's parse — OBJ's reader side has never threaded the shared
  `cancellation.ts` primitive into `parseOBJDocument`'s loop, and the
  viewer's own loop follows that same precedent rather than diverging from
  it.
- An optional "color by object/group" display mode (using a deterministic
  palette, explicitly not the file's real materials) was considered but
  deferred — the current viewer always renders with one neutral,
  user-selectable model color, and per-segment visibility is the only
  per-segment display feature Phase 4A ships.
- The 3MF Viewer's scene tree shows each segment's *object-level default*
  color/material reference (`colorResourceRef`) as a compact label; a
  segment whose triangles use per-triangle color overrides that differ
  from the object default won't show that per-triangle detail in the
  label — the rendered geometry itself (in "Embedded colors" mode) is
  still fully per-corner accurate, this only affects the scene-tree
  summary text.
- 3MF texture-based coloring (`texture2d`/`texture2dgroup`), beam
  lattices, slice stacks and production/volumetric/secure-content
  extension elements are detected and disclosed with a warning, never
  decoded or rendered — including texture2d image parts, which are never
  fetched even though they live inside the same package (rendering an
  actual image would need a genuinely new decode path this phase doesn't
  add). A production-extension cross-part reference (a
  `<component>`/`<item>` with a `path` attribute pointing at another
  package part) is detected and skipped, never followed — this viewer
  only ever reads the primary model part, since "Multiple-file viewing"
  is explicitly out of scope for Phase 4.
- 3MF thumbnail *presence* (a package's `Metadata/thumbnail.*` part) isn't
  currently surfaced as its own stat — thumbnails are never decoded or
  displayed either way, consistent with not rendering any other package
  image resource, so this is a minor reporting gap rather than a
  functional one.
- Unknown (non-standard) `<metadata>` keys are extracted individually
  like known ones (Title, Designer, etc. just get a friendlier label) —
  they aren't specially aggregated into a single "N other entries"
  summary, though the shared `maxMetadataEntries`/`maxMetadataBytes`
  ceilings still bound the total regardless of how many are unknown.
- `/online-stl-viewer/` is a static-host 301 redirect
  (`public/_redirects`) to `/stl-viewer/`, not a second page — this
  matters less than avoiding duplicate/competing content for the same
  search intent.
- No converter preserves colors, materials or textures — STL can't store
  them, so this is a format limitation, not a missing feature; a visible
  warning appears before download when a file includes any of these. No
  converter fetches an externally-referenced file (a 3MF texture path,
  an OBJ `.mtl` library, a GLB external buffer/image) either.
- The GLB converter doesn't implement `KHR_mesh_quantization`,
  `KHR_draco_mesh_compression` or `EXT_meshopt_compression` — quantized
  or compressed geometry is rejected with a clear error rather than
  misread.
- Neither the STL→OBJ nor the STL→3MF converter merges anything but
  bit-for-bit identical vertices — neither ever welds nearby vertices
  with a distance tolerance, since that would be mesh repair, not format
  conversion.
- The STL→3MF converter always declares its output unit as millimetres
  — a stated convention, never a detected fact about the source STL,
  which has no unit field at all.
- The PLY converter rejects a face with no measurable area as a parse
  error rather than silently skipping it, since it reuses the same
  polygon triangulator OBJ uses byte-for-byte — a real-world 3D scan
  with a degenerate face (a common scanning artifact) currently fails to
  convert rather than converting with that one face dropped.
- A PLY file containing only a `vertex` element (no `face` element at
  all — a raw point cloud) is rejected rather than converted: turning
  scattered points into a surface is a reconstruction problem, not a
  format-conversion one.
- The GLB Viewer renders `baseColorTexture` only — metallic-roughness,
  normal and occlusion texture maps are detected and reported (a clear
  warning, plus the material panel's own "Textures" note), but never
  decoded; affected surfaces still render correctly using their material
  factors alone.
- `KHR_texture_transform`, any UV set beyond `TEXCOORD_0`, and WebP
  images are all detected and disable just the affected texture (falling
  back to material factors) rather than rendering it incorrectly — a
  deliberate "don't guess" choice consistent with every other phase's
  "detect, don't decode" precedent, not a bug.
- Tangent presence and count are parsed and shown in model info, but no
  `TANGENT` attribute is ever bound to the Three.js geometry, since
  normal-map rendering isn't implemented this phase — explicitly
  permitted by this phase's own spec ("retain tangent metadata but do not
  force unnecessary GPU attributes").
- Animation channels, skin deformation and morph targets are detected,
  counted and disclosed with a warning, but never applied — only the
  file's static default-pose scene renders, matching how the GLB→STL
  converter already treats the same content.
- The PLY Viewer only recognizes the conventional `vertex1`/`vertex2`
  scalar-integer `edge` layout; any other edge property naming is
  detected, counted as an unknown element, and skipped with a warning
  rather than guessed at.
- UV pairs on a PLY file's vertices are read and reported as metadata
  only — this viewer never samples them against a texture, since PLY has
  no image/material concept at all.
- The PLY Viewer's smooth-normal fallback is computed per *vertex*, not
  per primitive (PLY has no primitives) — a mesh with a genuinely hard
  edge between two faces sharing a vertex will still shade smoothly
  there unless the file supplies its own `nx`/`ny`/`nz` for that vertex.
- The FBX Viewer supports **binary FBX 7000–7700 only**. An ASCII FBX
  file, or a binary version outside that range, is rejected with a
  clear, specific error rather than a best-effort guess — MeshWrench makes
  no claim of universal FBX compatibility.
- The FBX Viewer is a **static-mesh viewer**. Animation stacks/curves,
  skin deformers, skeletons, blend shapes, cameras, lights, NURBS/patch
  geometry, subdivision surfaces, constraints and layered textures are
  all detected and listed in the model-info panel's unsupported-features
  summary, but never applied — only the file's default, undeformed base
  geometry ever renders. MeshWrench does not claim animated, rigged or
  skinned FBX support.
- Materials render a practical Lambert/Phong subset: diffuse color,
  diffuse factor, and opacity where it's deterministically available
  from the file's own declared properties. A texture embedded directly
  in the file (via a `Video` object's own embedded bytes) is decoded and
  shown, the same main-thread `createImageBitmap()` approach the GLB
  Viewer uses for its own embedded base-color textures. A texture that
  only references an external file path is detected and disclosed, but
  that path is never fetched — MeshWrench has no server-side file-processing
  route to fetch it from, and never makes an external request of any
  kind while resolving a file.
- Binary FBX's zlib-compressed typed-array properties (the common case
  for a real-world exported vertex/index/normal array) are decompressed
  via `fflate`'s `unzlibSync`, with the declared decompressed size
  checked against a ceiling *before* the output buffer is allocated —
  the same "validate before allocating from an untrusted declared size"
  discipline 3MF's own ZIP-entry decompression already established.
- The Universal 3D File Viewer (`/viewer/`) reduces two per-format
  capabilities from what that format's own dedicated page offers: the
  GLB adapter drops the "color by node" mode (`/glb-viewer/` keeps it),
  and FBX's per-polygon material variation still renders as one material
  per mesh instance (the same limitation `/fbx-viewer/` itself already
  has). Every other per-format feature — including GLB's multi-material
  groups, PLY's shared surface/edges/points buffers, OBJ's per-object
  visibility and 3MF's declared-unit dimensions — is unreduced. The five
  dedicated single-format pages remain their own indexed routes; `/viewer/`
  dispatches to them rather than replacing them.
- Content-based format detection is a fast, bounded classification (a
  small fixed byte prefix per format), not a full parse — a genuine
  parse error inside a correctly-detected file is still caught and
  reported by that format's own worker, the same way it always is when
  that format's dedicated page is used directly.
- STL Diagnostics uses **exact float32 vertex identity only** — never
  distance-tolerance welding. Two positions differing by even one
  float32 ULP are distinct vertices; welding is explicitly deferred to
  Phase 6 (STL Repair).
- STL Diagnostics' self-intersection check has an explicit candidate-pair
  safety ceiling; browser verification against a 57,120-triangle sphere
  fixture hit it and correctly reported the check as skipped rather than
  falsely passing — every other check still completes normally. Dense,
  highly-curved meshes in roughly this size range and above may see
  self-intersection checking skipped even when otherwise well-formed.
- STL Diagnostics is diagnostics only — it never modifies, repairs,
  welds, reorients or exports a changed mesh.
- `/stl-checker/` and `/stl-validator/` both self-canonicalize rather
  than one pointing at the other, since their copy is genuinely distinct;
  both mount the exact same shared client script and results components.
- STL Repair resolves self-intersections by detection only, never
  automatically. Non-manifold edges beyond deterministic duplicate/
  degenerate-face cleanup stay unresolved and reported, never
  force-fixed. There is no batch/multi-file repair and no saved/reusable
  custom presets this phase — one file, one run.
- `/stl-repair/`, `/make-stl-watertight/` and `/repair-non-manifold-stl/`
  all self-canonicalize rather than one pointing at another, since each
  page's copy is genuinely distinct; all three mount the exact same
  shared client script and repair components.
- See `docs/ARCHITECTURE.md`'s "Known limitations" sections (one per
  phase) for the complete, current list.

## Phase 9 complete (including closeout) — Phase 10 handoff

Phase 8 (STL Optimization, including its closeout) and Phase 9 (the
G-code Cluster, including its own closeout pass) are both complete.
Phase 9 built a from-scratch, strictly test-first G-code parsing/
analysis engine (`src/lib/gcode/`, 22 modules, ~340+ tests) — the first
phase to touch G-code at all, and the first phase whose format isn't a
triangle mesh, so it shares nothing with `src/lib/mesh/*`. Five routes
(`/gcode-viewer/`, `/gcode-visualizer/`, `/gcode-simulator/`,
`/gcode-layer-viewer/`, `/gcode-toolpath-viewer/`) share one parser/
worker/renderer/client. This is a static viewer/visualizer/visual
simulator only — it never executes G-code, never uses WebSerial, and
never connects to a printer; see "G-code Cluster (Phase 9)" and "Phase
9 closeout" in `docs/ARCHITECTURE.md` for the full architecture,
including the documented G90/G91-vs-M82/M83 modal-state policy, the arc
chord-error/subdivision policy (and the R-form sign-convention bug this
phase's own TDD caught before merge), the dialect/layer-inference rules
(including the now-real, reachable `"mixed"` mode), the temperature
color mode, and two genuine browser-verification discoveries:
`linearMoveCount` was originally derived as `generatedSegments -
arcLineCount`, silently wrong whenever an arc expanded into more than
one render segment; and, found during the closeout's own cancellation
testing, `ChunkedLineDecoder` had a severe quadratic-time defect plus an
independent correctness bug that spuriously truncated ordinary files —
both fixed with dedicated regression tests. See "Phase 9 closeout" in
`docs/ARCHITECTURE.md` for the full record.
`npm run seo:audit` remains a standing, re-runnable gate (0 non-domain
critical issues, 0 warnings across 28 routes; the one remaining blocker
is still the placeholder production domain — see
`docs/SEO-LAUNCH-CHECKLIST.md`).

## Phase 10 complete — Pro Feature Set (batch processing)

Strictly test-first: `src/lib/pro/` (entitlement interface) and
`src/lib/batch/` (batch infrastructure — job queue, a concurrency-bounded
scheduler with a live-adjustable 1–2 file cap, memory budget, an
exhaustive 8-operation adapter registry reusing every existing
single-file worker/library unchanged, a generic plan-workflow state
machine for repair/optimize, ZIP/report builders, local preset
persistence with full manage-UI — save/rename/delete/export/import).
All 8 batch-capable operations — the 6 conversions (3MF/OBJ/GLB/PLY→STL,
STL→OBJ, STL→3MF) plus STL Repair and STL Optimization — are live-wired
into their existing pages behind a Single file/Batch tab, lazy-loaded (a
Free user's page load fetches ZERO batch code — verified against a real
production build, not just dev mode) and gated by the entitlement layer.
STL Repair and STL Optimization use a plan-before-mutation workflow (file
intake → analyze/plan → aggregate confirmation → run), matching their
single-file pages' own "see a plan before mutation" guarantee.
**Production always resolves Free** until Phase 11 — no bypass exists,
verified at both the source level (grepped `_client.ts` files,
forbidden-token checks for any URL/storage/global-based unlock) and the
built-bundle level (`dist/` grepped for the test provider and every
Phase 11 payment/licensing term). See "Pro Feature Set (Phase 10)" and
"Phase 10 closeout" in `docs/ARCHITECTURE.md` for the full architecture
and record, and "Phase 11 handoff: Dodo Payments and licensing" for what
comes next.
