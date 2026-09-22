# MeshKit

MeshKit is a privacy-first, browser-based toolkit for viewing, converting,
diagnosing, repairing and optimizing 3D files. Every tool runs entirely on
the visitor's device — a file's bytes are never uploaded, and there is no
file-processing backend, account system or database.

**Current status: Phase 3 complete — Phase 3F, PLY → STL Converter.** The
homepage and seven production tools are live:
[`/stl-viewer/`](src/pages/stl-viewer/index.astro) (Phase 2),
[`/3mf-to-stl/`](src/pages/3mf-to-stl/index.astro) (Phase 3A),
[`/obj-to-stl/`](src/pages/obj-to-stl/index.astro) (Phase 3B),
[`/glb-to-stl/`](src/pages/glb-to-stl/index.astro) (Phase 3C),
[`/stl-to-obj/`](src/pages/stl-to-obj/index.astro) (Phase 3D),
[`/stl-to-3mf/`](src/pages/stl-to-3mf/index.astro) (Phase 3E) and
[`/ply-to-stl/`](src/pages/ply-to-stl/index.astro) (Phase 3F) — all six
planned Phase 3 converters. All seven are built on the same Phase 1
foundation — SEO/layout infrastructure, local file intake, a Web Worker
protocol, a WASM loader and a Three.js viewport. `/foundation-preview/`
remains as a non-public technical proof of the underlying pipeline.

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

Before deploying to a real domain, update the origin in **two** places so
canonical URLs, Open Graph tags, the sitemap and `robots.txt` all agree:

- `astro.config.mjs` → `site`
- `src/config/site.ts` → `siteConfig.siteUrl`
- `public/robots.txt` → the `Sitemap:` line

## Architecture overview

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full
technical writeup: the privacy boundary, the file/worker/WASM/viewport
lifecycles, resource-disposal rules, the STL parser, the 3MF package/ZIP
safety model, OPC relationship resolution, transform composition and
reflected-geometry handling, binary STL serialization, and the
recommended Phase 4 (OBJ Viewer) starting point. Short version:

```
src/
├── components/
│   ├── seo/        SEOHead.astro, StructuredData.astro
│   ├── site/       SiteHeader.astro, SiteFooter.astro (shared chrome)
│   └── tools/      LocalFilePicker, ToolStatus, ToolViewport, ToolError,
│                    PrivacyNotice, ModelInfoPanel, ViewerControls —
│                    presentation-only scaffolding each tool page wires
│                    up with its own client script
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
│   │                   units.ts, convert.ts
│   ├── obj/           types.ts, errors.ts, tokenizer.ts, indices.ts,
│   │                   triangulate.ts, parser.ts, convert.ts, formatting.ts
│   ├── glb/           types.ts, errors.ts, container.ts, schema.ts,
│   │                   accessors.ts, transforms.ts, primitives.ts,
│   │                   resolve-scene.ts, convert.ts, formatting.ts
│   ├── stl-to-obj/    types.ts, errors.ts, convert.ts, formatting.ts
│   ├── stl-to-threemf/ types.ts, errors.ts, convert.ts, formatting.ts
│   ├── ply/           types.ts, errors.ts, scalar-types.ts, header.ts,
│   │                   scalar-reader.ts, ascii-reader.ts, binary-reader.ts,
│   │                   properties.ts, triangulate.ts, parser.ts, convert.ts,
│   │                   formatting.ts
│   ├── mesh/          deduplicate.ts, number-format.ts, triangulate.ts,
│   │                   errors.ts — format-neutral geometry helpers shared
│   │                   by every *writer* (OBJ, 3MF) and, for triangulation,
│   │                   by the OBJ and PLY *readers* too
│   ├── cancellation.ts shared mid-loop cancellation primitive
│   ├── browser/      capabilities.ts
│   ├── errors.ts     shared ErrorCode vocabulary
│   └── tool-state.ts shared ToolState union
├── workers/         foundation.worker.ts, stl-viewer.worker.ts,
│                     threemf-to-stl.worker.ts, obj-to-stl.worker.ts,
│                     glb-to-stl.worker.ts, stl-to-obj.worker.ts,
│                     stl-to-threemf.worker.ts, ply-to-stl.worker.ts
└── pages/
    ├── index.astro                 the public homepage
    ├── stl-viewer/                 the STL Viewer — index.astro + _client.ts
    ├── 3mf-to-stl/                 the 3MF→STL converter — index.astro + _client.ts
    ├── obj-to-stl/                 the OBJ→STL converter — index.astro + _client.ts
    ├── glb-to-stl/                 the GLB→STL converter — index.astro + _client.ts
    ├── stl-to-obj/                 the STL→OBJ converter — index.astro + _client.ts
    ├── stl-to-3mf/                 the STL→3MF converter — index.astro + _client.ts
    ├── ply-to-stl/                 the PLY→STL converter — index.astro + _client.ts
    └── foundation-preview/         internal, noindex, proves the architecture
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

## Current limitations

- Only STL viewing and 3MF→STL/OBJ→STL/GLB→STL/STL→OBJ/STL→3MF/PLY→STL
  conversion exist so far — no FBX support, and no diagnostics, repair or
  optimization yet. All six planned Phase 3 converters are complete; see
  Phase 4 below.
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
- See `docs/ARCHITECTURE.md`'s "Known limitations" sections (one per
  phase) for the complete, current list.

## Phase 4 handoff

Start with an OBJ Viewer — see **"Phase 4 handoff: OBJ Viewer"** at the
bottom of `docs/ARCHITECTURE.md` for the recommended build order. Phase 3
(all six planned converters) is complete.
