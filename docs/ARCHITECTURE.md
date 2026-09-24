# Architecture

This document covers the Phase 1 foundation in depth: the privacy
boundary, the file/worker/WASM/viewport lifecycles, and how to extend
each piece in a later phase. For setup and commands, see the [README](../README.md).

## Privacy boundary

Nothing about a selected file — its bytes, its name, its size, derived
geometry — ever leaves the browser. Concretely:

- There is no API route that accepts file data. There is no server at
  all beyond serving static files.
- `FileSession` (`src/lib/files/file-session.ts`) only ever creates
  **local** object URLs (`URL.createObjectURL`) and reads bytes via the
  browser's `File.arrayBuffer()`. Neither touches the network.
- The Web Worker protocol transfers a file's `ArrayBuffer` to a
  same-origin Worker via a transferable object — never over `fetch`,
  `XMLHttpRequest`, `navigator.sendBeacon`, or any analytics call.
- `foundation.worker.ts` computes only byte length and a checksum — it
  never serializes file content back out of the worker except as that
  small numeric summary.
- No file name, file content or derived metadata is ever logged in a
  production build (see `toSafeError` in `src/lib/errors.ts`, which
  gates diagnostic `console.debug` calls behind `import.meta.env.DEV`).

If you add analytics in a later phase, it must never receive a file
name, extension, size or any derived geometry data.

## File lifecycle

1. A page renders `<LocalFilePicker>` (presentation only — no wiring).
2. The page's own client script listens for the input's `change` event
   and calls `validateSelectedFile(file, config)`
   (`src/lib/files/validation.ts`). Validation is **extension-based**,
   not MIME-based — browsers report `file.type` inconsistently (or not
   at all) for 3D formats, so trusting it alone would reject valid files
   or silently accept mislabeled ones.
3. On success, the page wraps the file in a `new FileSession(file, extension)`
   (`src/lib/files/file-session.ts`). A session tracks every object URL
   it hands out and any cleanup callback registered against it (e.g.
   `session.registerCleanup(() => workerClient.cancel())`).
4. When the user selects a **different** file, the page must call
   `session.dispose()` on the old session before creating a new one.
   `dispose()` is idempotent and safe to call more than once.
5. `session.dispose()` also runs when the user clicks "Reset" or leaves
   the tool. It revokes every object URL, drops the cached buffer
   reference, and runs registered cleanups (typically cancelling any
   in-flight worker task for that file).

**Rule of thumb for a new tool page:** one `FileSession` per selected
file, created after validation succeeds, disposed before the next one is
created and on every reset/teardown path.

## Worker protocol

`src/lib/workers/protocol.ts` defines the message shapes
(`WorkerRequest` / `WorkerResponse`) every future worker should speak.
`src/lib/workers/worker-client.ts`'s `WorkerClient` wraps a raw
`Worker` (via the narrow `WorkerLike` interface, so it's testable
without a browser) and adds:

- **Request/response correlation** by `requestId`.
- **Stale-response protection.** The client tracks the
  `initializeRequestId` (the handshake) and `activeProcessRequestId`
  (the current file's processing request) separately. If the user
  replaces the selected file mid-processing, the old `process` call's
  `requestId` stops being "active" — any `progress`/`result`/`error`/
  `cancelled` message that later arrives for it is silently dropped. See
  `worker-client.test.ts` for the exact behavior this protects.
- **Transferable buffers.** `client.process(fileName, format, buffer, options)`
  passes `buffer` as the second argument to `postMessage`'s transfer
  list, so the bytes are moved into the worker rather than copied.
- **Safe error mapping.** Worker-side failures arrive as a typed
  `{ code, message, recoverable }` (`src/lib/errors.ts`'s `ErrorCode`
  union) — never a raw stack trace.

### Adding a new worker for Phase 2+

1. Create `src/workers/<name>.worker.ts`. Speak `WorkerRequest`/
   `WorkerResponse` from `src/lib/workers/protocol.ts` (extend the
   union if a new message shape is genuinely needed).
2. Construct it from a page's client script with:
   ```ts
   new Worker(new URL("../../workers/<name>.worker.ts", import.meta.url), { type: "module" })
   ```
   (relative to the client script's own location — see
   `foundation-preview/_client.ts` for a worked example). Vite bundles
   this as its own chunk automatically; nothing needs registering
   elsewhere.
3. Wrap it in a `new WorkerClient(factory, events)` and drive it exactly
   like the foundation preview does: `initialize()` once, `process()`
   per file, `cancel()` on demand, `dispose()` on teardown.

## WASM loading

`src/lib/wasm/wasm-loader.ts`'s `loadWasmModule(url, options)`:

1. Checks `WebAssembly` support first (`WASM_UNSUPPORTED` if absent).
2. `fetch`es the module from a **local, same-origin** static URL only —
   never a remote one.
3. `WebAssembly.compile`s then `WebAssembly.instantiate`s it, mapping
   each distinct failure mode to its own error code
   (`WASM_LOAD_FAILED` / `WASM_COMPILE_FAILED` / `WASM_INIT_FAILED`).
4. Caches the resulting promise by URL in a module-level `Map`, so
   calling it again for the same URL — from a different tool page, or a
   second time on the same page — returns the same instance instead of
   re-fetching/re-compiling. A failed load is evicted from the cache so
   a retry is possible; `resetWasmCache()` clears it explicitly.

### Where future WASM modules belong

Static files go in `public/wasm/<name>.wasm`, loaded with
`loadWasmModule("/wasm/<name>.wasm")`. `public/wasm/foundation.wasm` is
a 41-byte hand-built fixture (see `public/wasm/README.md`) that proves
the loader works — it is **not** a starting point for a real geometry
library; a real module should come from an actual toolchain (e.g. a
Rust/C++ mesh library compiled to WASM).

### Static hosting requirements

- **MIME type:** `.wasm` files must be served as `application/wasm`.
  `public/_headers` sets this explicitly for `/wasm/*` because some
  static hosts default to `application/octet-stream`, which prevents
  streaming compilation (`WebAssembly.instantiateStreaming`) — this
  loader currently uses `WebAssembly.compile` on a buffered
  `ArrayBuffer` rather than streaming, so a wrong MIME type would still
  work, just slower; get the header right anyway so a future streaming
  upgrade doesn't silently regress.
- **Caching:** `.wasm` files are content-addressed by filename convention
  in this project (change the name if the content changes), so
  `public/_headers` marks `/wasm/*` as `immutable` with a one-year
  `max-age`.
- **CSP:** loading requires `connect-src 'self'` (for the `fetch`) and,
  once instantiated, nothing else — no `unsafe-eval` is needed because
  `WebAssembly.compile`/`instantiate` are not covered by `script-src`'s
  `unsafe-eval` restriction the way `eval()`/`new Function()` are.

### How worker code should initialize a WASM module

Call `loadWasmModule` **inside** the worker (not on the main thread) so
compilation never blocks the UI thread, and so the worker owns the
resulting `WasmModuleHandle`. `foundation.worker.ts` doesn't do this
today — it only proves the checksum path — but a real converter/repair
worker in a later phase should `import { loadWasmModule } from "../lib/wasm/wasm-loader"`
at the top of the worker file and call it once during the worker's own
`"initialize"` message handling, caching the resulting handle for
subsequent `"process"` messages.

## Three.js viewport lifecycle

`src/lib/three/viewport.ts`'s `ToolViewport`:

- Creates its own `<canvas>`, `WebGLRenderer`, `Scene`, `PerspectiveCamera`
  and basic ambient + directional lighting.
- Caps `devicePixelRatio` (default max `2`) to protect performance on
  high-DPI displays.
- Renders **on demand** via `requestRender()`, not a continuous loop —
  multiple calls before the next frame are coalesced. A tool that needs
  continuous animation (like the foundation preview's spinning
  wireframe) drives its own `requestAnimationFrame` loop and calls
  `requestRender()` each tick; see `foundation-preview/_client.ts` for
  the pattern, including how it respects `prefers-reduced-motion` and
  pauses via `setVisible(false)` on `visibilitychange`.
- Watches its container with a `ResizeObserver` and resizes the
  renderer/camera aspect without stretching.
- Listens for `webglcontextlost`, calls `preventDefault()` on it (so the
  browser doesn't discard the context outright), stops the render loop,
  and reports `WEBGL_CONTEXT_LOST` via the `onContextLost` callback.
- `dispose()` — safe to call more than once — disposes every geometry
  and material (and any textures they reference) via
  `src/lib/three/disposal.ts`, disposes the renderer, force-loses its
  GL context, and removes the canvas from the DOM.

**Rule for a new tool page:** create exactly one `ToolViewport` per tool
instance, add/remove `Object3D`s to `viewport.scene` as the user's file
changes (disposing the old ones with `disposeObject3D` first), and call
`viewport.dispose()` on the same teardown path as the file session.

## Error codes

All of file validation, the worker protocol, the WASM loader and the
viewport report failures through the single `ErrorCode` union in
`src/lib/errors.ts`, not ad hoc strings. `createSafeError(code, detail?)`
builds a `{ code, message, recoverable }` object safe to render directly
in the UI; `toSafeError(code, cause)` additionally logs `cause` to
`console.debug` in dev builds only, so a real exception's stack trace is
available while developing but never reaches production UI or a
production console.

## Adding a future tool page

1. Add a `ToolDefinition` to `src/config/tools.ts` with `status: "planned"`
   (or `"development"` once you start building it) — this is a planning
   registry only; it does not generate routes.
2. Create `src/pages/<route>/index.astro` using `ToolLayout` (see
   `src/pages/foundation-preview/index.astro` for every slot in use).
   Pass `breadcrumbs`/`faqs`/`webApplication` as appropriate — only set
   `webApplication` once the tool is genuinely functional, per the "no
   fake WebApplication for unfinished functionality" rule.
3. Give the page its own colocated client script (e.g.
   `<route>.client.ts` next to `index.astro`) that wires
   `LocalFilePicker` → `validateSelectedFile` → `FileSession` →
   `WorkerClient` → `ToolStatus`/`ToolViewport`/`ToolError`, following
   `foundation-preview/_client.ts` as the reference implementation.
4. Add the route to `astro.config.mjs`'s sitemap `filter` only if it
   should be **excluded** (public tool pages are included by default;
   only internal/test routes need excluding).

## STL Viewer (Phase 2)

`/stl-viewer/` is the first production tool, built entirely on the Phase 1
foundation described above — no foundation module was replaced, only
`ToolViewport` gained one new optional constructor field
(`preserveDrawingBuffer`, for screenshot export; see below).

### STL parser architecture

```text
src/lib/stl/
├── types.ts          STLEncoding, STLParseResult, STLBounds, limits
├── errors.ts          STLParseException + toSTLSafeError, on top of lib/errors.ts
├── detect.ts           binary-vs-ASCII detection
├── parse-binary.ts    binary STL → raw positions/normals
├── parse-ascii.ts      ASCII STL → raw positions/normals
├── bounds.ts            min/max/size/center from a position buffer
├── normals.ts            shared face-normal math (used by parse.ts and 3MF's resolve-scene.ts)
├── serialize-binary.ts   the inverse of parse-binary.ts — geometry → binary STL bytes (added in Phase 3A)
├── format.ts            display-only formatting (units, file size, triangle count)
└── parse.ts             orchestrator: detect → parse → resolve normals → bounds
```

`parse.ts`'s `parseSTL(buffer, limits)` is the only function other code
should call — `parse-binary.ts`/`parse-ascii.ts` are implementation
details. `test-fixtures.ts` (not shipped — only imported by `*.test.ts`
files) builds small deterministic binary/ASCII buffers for tests instead
of checking in binary fixture files.

STL-specific error codes (`STL_FORMAT_UNRECOGNIZED`,
`STL_BINARY_TRUNCATED`, `STL_ASCII_MALFORMED`,
`STL_INVALID_TRIANGLE_COUNT`, `STL_NON_FINITE_VERTEX`, `STL_TOO_COMPLEX`,
`STL_EMPTY_GEOMETRY`) were added to the **shared** `ErrorCode` union in
`src/lib/errors.ts` rather than a parallel STL-only error type, matching
Phase 1's "one error vocabulary" design. `src/lib/stl/errors.ts` adds a
thin `STLParseException` (carries a code, thrown by the parser modules)
and `toSTLSafeError()` to map it to the shared `SafeError` shape.

### Why plain TypeScript instead of WASM for STL parsing

Phase 1 built a WASM loader specifically so future format libraries could
use it, but STL parsing itself doesn't need it: the binary format is a
fixed 80-byte header + a `uint32` triangle count + fixed 50-byte records
— a simple `DataView` walk, not a computationally heavy algorithm.
ASCII STL is a small, linear grammar. Both parse in plain TypeScript at
speeds that are more than adequate for a viewer (not a batch pipeline),
without pulling in a compiled dependency or a build toolchain for it. A
future format that's genuinely CPU-bound (e.g. mesh repair/optimization
algorithms in a later phase) is exactly where `src/lib/wasm/wasm-loader.ts`
is meant to be used — see "How worker code should initialize a WASM
module" above.

### Binary vs ASCII detection strategy

See `src/lib/stl/detect.ts`. The naive approach — "does the file start
with the bytes `solid`?" — is wrong: binary STL's 80-byte header is
free-form text, and several real exporters (SolidWorks, Simplify3D and
others) write `solid ...` there anyway. `detectSTLEncoding()` instead:

1. Checks whether the file's length exactly matches
   `80 + 4 + triangleCount * 50` using the declared triangle count read
   from bytes 80–83 — this is the only signal that's actually
   authoritative for binary STL, since the format's length is fully
   determined by that count.
2. If that doesn't match, checks for ASCII grammar (`solid` at the start
   **and** a `facet normal` token present) as a second, independent signal.
3. If neither matches confidently, returns a best-guess (`binary`) marked
   `confident: false`. `parse.ts` retries the other format once if the
   first guess throws, before finally giving up with
   `STL_FORMAT_UNRECOGNIZED` — so a genuinely unrecognizable file gets a
   clear "not a valid STL" error instead of a confusing truncation error
   for the wrong format.

### Safety limits (not Pro gating)

Two independent layers protect the browser from pathological input, and
neither is a paid-tier restriction:

- **File-size ceiling** (100 MB, enforced by `validateSelectedFile` in the
  page's client script, same as any other tool) — rejects absurdly large
  uploads before they're even read.
- **Triangle-count ceiling** (`DEFAULT_STL_LIMITS.maxTriangles` in
  `src/lib/stl/types.ts`) — enforced *inside* the parser, independent of
  file size, because a hostile or corrupted file could declare an
  enormous triangle count without necessarily being a huge file. Binary
  parsing also cross-checks the declared count against the actual buffer
  length before allocating anything (`STL_BINARY_TRUNCATED` /
  `STL_TOO_COMPLEX`), so a corrupted header can never trigger an
  out-of-bounds read or an unbounded allocation.

Both limits are plain numbers in source, easy to raise later for a Pro
"large-file mode" — Phase 2 does not implement that; it only makes sure
the free viewer fails safely rather than freezing the tab.

### Worker data flow

`src/workers/stl-viewer.worker.ts` follows `foundation.worker.ts`'s
pattern exactly: `initialize` → `ready`, `process` → a sequence of
`progress` messages (`reading` → `detecting-format` → `parsing` →
`calculating-bounds` → `preparing-model` → `complete`) → `result`,
`cancel` checked between stages, `dispose` clears worker-local state. STL
parsing is fast enough that these stages are more about giving the UI
something honest to show than about genuine long-running work — there is
no fabricated percentage; the UI just displays the stage name.

**Transferable buffer ownership:** the main thread transfers the original
file `ArrayBuffer` into the worker (`postMessage(request, [buffer])`,
handled by the unchanged Phase 1 `WorkerClient.process()`). The worker
never sends that buffer back — after parsing, only the much smaller
derived `Float32Array` position/normal buffers are transferred back
(`postMessage(response, [positions.buffer, normals.buffer])`). The
original file bytes are never copied, never leave the worker's local
scope, and become eligible for garbage collection the moment
`handleProcess()` returns.

### Three.js geometry lifecycle

The client script (`src/pages/stl-viewer/_client.ts`) builds one
`THREE.BufferGeometry` per loaded model directly from the transferred
`positions`/`normals` typed arrays (`setAttribute("position", ...)` /
`setAttribute("normal", ...)` — no copying). Before building a new one,
`disposeCurrentModel()` removes the previous mesh from the scene and
disposes its geometry and material (textures would be disposed too, via
`src/lib/three/disposal.ts`, if a future version added them). This runs
on every replacement file, on "Start over", and on `pagehide`.

The mesh is **translated** (not its geometry mutated) so its bounding
sphere is centered at the origin for predictable framing — the
**displayed** dimensions in the info panel always come from the
originally-computed, uncentered `bounds` the worker returned, so
centering never affects what the user sees as "the model's size."

### Camera-fitting strategy

`fitCameraAndControls(radius)` positions the camera at a distance derived
from the model's **bounding sphere radius** (not its bounding box), so
it works uniformly for portrait, landscape, and extremely flat or tall
models without special-casing any of them — a sphere fit is
rotation-invariant. Near/far planes are set relative to that same
distance so nearby geometry is never clipped and the far plane is never
tighter than necessary. "Reset camera" and "Fit model" call the exact
same function; there is currently only one meaningful "fit" for a
single-model viewer, so no separate state is kept for them.

**A real bug found and fixed during Phase 2 verification:** three.js's
`OrbitControls` (with `enableDamping: true`) keeps an internal
`sphericalDelta` that it re-applies, decaying, on every `update()` call
— including a call made *after* the code has just repositioned the
camera programmatically. A real drag/zoom gesture can leave a large
residual delta that hasn't fully decayed by the time a user clicks
"Reset camera," and it would silently re-apply itself on top of the
reset, making the button appear to do nothing. The fix: before
positioning the camera, `fitCameraAndControls` does one `update()` call
with `enableDamping` temporarily forced to `false` (which unconditionally
zeroes the delta instead of decaying it), then restores the original
damping setting before the real, camera-positioning `update()` call. See
the comment directly above `fitCameraAndControls` in `_client.ts`. This
is a real gotcha worth knowing about for any future tool that
programmatically repositions an `OrbitControls`-driven camera. (The 3MF
converter's `_client.ts` reuses this exact fix.)

Damping's own continuous-update loop (needed for the inertia to visibly
decay after a drag) is *not* a permanent render loop: it starts on the
controls' `"start"` event and stops itself ~500ms after the `"end"`
event, matching Phase 1's "render continuously only during active
control movement or short transitions" rule. `visibilitychange` also
stops it immediately and pauses the viewport (`viewport.setVisible`) when
the tab is hidden.

### Screenshot-export lifecycle

`ToolViewport` now accepts `preserveDrawingBuffer: true` (an opt-in,
backward-compatible addition to `ViewportOptions` — defaults to `false`
for every other tool) specifically so `canvas.toBlob()` can read back
whatever was last rendered, at any time, without needing to force and
wait for a fresh `requestAnimationFrame` first. That matters because
rendering is intentionally paused while the tab is hidden — a naive
"render, wait two rAFs, then capture" implementation would hang
indefinitely in that state. Every control that changes the view already
calls `requestRender()` itself, so the canvas is always current by the
time a user can actually click "Save screenshot" for real.

The export flow: `canvas.toBlob(cb, "image/png")` → `URL.createObjectURL`
→ a temporary, never-appended-to-visible-DOM-longer-than-necessary
`<a download>` → `.click()` → `.remove()` → `URL.revokeObjectURL`. The
filename comes from `src/lib/files/download.ts`'s
`buildScreenshotFilename()`, which strips the original filename's
extension and any character outside `[\w-]` before appending
`-meshkit-preview.png` — never inserted via `innerHTML`, and never
trusted as safe until sanitized. No watermark or branding is added to
the image itself.

### Unitless-dimension display

STL has no unit field — a model's numbers could represent anything. The
info panel labels every dimension "model units" by default
(`src/lib/stl/format.ts`'s `unitLabel("units")` → `"u"`). A "Display
dimensions as" selector lets the user *opt in* to treating the raw
numbers as millimeters — the common convention for 3D-printing STL
files — and see the equivalent in mm/cm/in; selecting it never touches
the geometry, only the numbers shown in the info panel (`convertDimension()`
is a pure display-time multiplication). This is local UI state only,
reset on every new file load.

### Route strategy: /online-stl-viewer/

`/stl-viewer/` is the only indexable page for this tool — its canonical
URL points to itself (`ToolLayout`'s `path` prop, unchanged Phase 1
mechanism). A second, near-duplicate `/online-stl-viewer/` page was
deliberately **not** built: it would compete with `/stl-viewer/` for the
same search intent (keyword cannibalization) without adding real content.
Instead, `public/_redirects` adds a host-level 301
(`/online-stl-viewer/ → /stl-viewer/`) using the Netlify/Cloudflare Pages
`_redirects` file convention — the same static-hosting convention
`public/_headers` already uses for security headers. If the site deploys
somewhere that doesn't honor `_redirects` (Vercel, a plain static host,
etc.), add the equivalent redirect rule in that host's own config; the
file itself is otherwise inert and harmless to leave in place.

### Extending the parser safely

To add support for a new STL quirk or a stricter check:

1. Add the new failure case to `parse-binary.ts` or `parse-ascii.ts`,
   throwing `stlError("SOME_CODE")` — add the code to `ErrorCode` in
   `src/lib/errors.ts` (with a `SAFE_MESSAGES` entry, and to
   `RECOVERABLE_CODES` if a user can plausibly fix it by picking another
   file) if it's genuinely new.
2. Add a fixture + test in the matching `*.test.ts` file using
   `test-fixtures.ts`'s builders (or extend them if the new case needs a
   fixture shape they don't support yet).
3. Never add a check that requires reading the *whole* file into memory
   more than once, and never remove the "validate before allocate"
   ordering in `parse-binary.ts` — that ordering is what makes the parser
   safe against hostile input.

## 3MF → STL Converter (Phase 3A)

`/3mf-to-stl/` is the first converter, and the first tool that both reads
*and* writes a binary format. It's built entirely on the Phase 1/2
foundation — the only Phase 2 change was extracting `parse.ts`'s private
normal-computation helper into a shared `src/lib/stl/normals.ts` (used by
both the STL parser and the 3MF scene resolver, so the cross-product math
exists in exactly one place) — everything else here is additive. This is
also the first phase to add an npm dependency (`fflate`, for the raw
DEFLATE algorithm only — see below).

### 3MF package structure

A 3MF file is an OPC (Open Packaging Conventions) package: a ZIP archive
containing `_rels/.rels` (relationships), one or more `.model` XML parts,
and optionally thumbnails/materials/textures/metadata. This project never
assumes the model lives at the conventional `3D/3dmodel.model` path
without checking relationships first — see "Relationship resolution"
below.

### ZIP safety: hand-rolled container parsing, `fflate` only for DEFLATE

`src/lib/threemf/package.ts` parses the ZIP **central directory** and
**local file headers** itself — reading the End-Of-Central-Directory
record, walking each central directory entry, and only then extracting
the one or two entries actually needed (never eagerly decompressing
everything in the archive). `fflate`'s `inflateSync` is used only for the
raw DEFLATE algorithm on those specific entries — never for parsing the
container format itself. This was a deliberate choice over just calling
`fflate.unzipSync()` with a filter: hand-parsing the central directory is
the only way to inspect the general-purpose bit flags directly, which is
required to *detect* encrypted entries (fflate's public API doesn't
expose this) rather than merely fail confusingly when decryption is
attempted.

Every safety check runs against central-directory **metadata**, before
any byte is decompressed:

- **Encrypted entries** — general-purpose flag bit 0 set → rejected
  (`THREEMF_ZIP_ENCRYPTED`).
- **Unsupported compression** — only method 0 (store) and 8 (deflate)
  are accepted; anything else (e.g. LZMA) → `THREEMF_ZIP_CORRUPT`.
- **Path traversal / absolute paths / null bytes / backslashes** in any
  entry name → the *whole package* is rejected
  (`THREEMF_INVALID_PACKAGE`), not just that one entry — a malicious name
  anywhere in the archive is treated as a hostile package, not a
  skippable file.
- **ZIP64** (needed for archives beyond standard 32-bit limits) → treated
  as `THREEMF_PACKAGE_TOO_LARGE`, since a legitimate 3MF model has no
  reason to need it.
- **Entry-count, single-entry size, total-decompressed-size and
  compression-ratio ceilings** (`ThreeMFLimits` in
  `src/lib/threemf/types.ts`) — each checked per-entry while walking the
  central directory, so a "ZIP bomb" package is rejected
  (`THREEMF_ZIP_BOMB_SUSPECTED`) before any inflate call ever runs.
- **After** decompression, the actual output length is checked against
  the declared uncompressed size as a second, independent layer — a
  central directory record that lies about size doesn't get a free pass
  just because it looked fine on paper.
- **Duplicate entry names** anywhere in the archive → rejected
  (`THREEMF_INVALID_PACKAGE`) — OPC requires unique part names, and two
  entries claiming the same path make "which one is real" undecidable.

### Relationship resolution

`src/lib/threemf/relationships.ts`'s `findPrimaryModelPath()` parses
`_rels/.rels` (via the shared XML tokenizer, never string-matching) to
find the `Relationship` whose `Type` is the 3D-model relationship URI.
Requirements enforced: reject `TargetMode="External"` (never fetched —
this project makes zero network requests, ever), normalize the `Target`
path against the package root and reject anything that resolves outside
it (`..` escaping), and reject if more than one such relationship exists
(ambiguous — which one is primary?). **Documented, narrow fallback:**
only when `_rels/.rels` is absent, or contains no usable 3D-model
relationship, does the code fall back to the conventional
`3D/3dmodel.model` path — never as a silent guess among multiple
candidates, and never when a relationship exists but points elsewhere.

### XML parsing strategy

`src/lib/threemf/xml.ts` is a hand-written, minimal SAX-style tokenizer
(not a DOM parser, not a third-party library), shared by both
relationship and model-document parsing. It deliberately:

- Rejects any `<!DOCTYPE`, `<!ENTITY`, or other markup declaration
  outright — this closes off classic XXE (XML External Entity) attacks
  by construction, since no DTD is ever loaded and no entity beyond the
  five predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) and
  numeric character references is ever resolved.
- Ignores text/CDATA content entirely — every piece of data this project
  reads from OPC/3MF XML (vertex coordinates, triangle indices,
  transforms, relationship targets, unit, object ids) lives in
  **attributes**, not text nodes, so there was never a reason to parse
  text content in the first place.
- Strips namespace prefixes to local names rather than doing full
  namespace resolution — sufficient for tolerating valid prefixes
  (`<m:model>`, `p:UUID` extension attributes, etc.) without the
  complexity of a real namespace-aware parser, since this project only
  ever looks for a small, fixed set of local element/attribute names.
- Uses only linear, non-backtracking-prone regex patterns (a flat "list
  of attributes" repetition, no nested quantifiers) — safe from
  catastrophic backtracking regardless of input size.

Parsed XML strings are not retained past `parseThreeMFModel()`/
`parseRelationships()` returning — once the raw `ThreeMFModel`/
relationship list is built, the source string itself has no further
references and is eligible for garbage collection.

### 3MF unit handling

`src/lib/threemf/units.ts` implements the exact core-spec conversion
table (micron/millimeter/centimeter/inch/foot/meter → millimeters),
defaults to millimeter when a model declares no unit (the spec's own
default), and **rejects** any unrecognized unit name
(`THREEMF_UNIT_UNSUPPORTED`) rather than guessing. Conversion is applied
**exactly once**, and — critically — **after** all transform composition
happens in the model's native unit space
(`resolve-scene.ts`'s `transformVertex()`): a transform's translation
component is expressed in the same unit as the model, so converting
units before applying transforms would corrupt every translated
position. Only the final, fully-transformed coordinate is scaled to mm.

### Object / component / build resolution

`src/lib/threemf/model-parser.ts` parses raw, unresolved objects (mesh
or components) and build items. `src/lib/threemf/resolve-scene.ts` then
walks every `<build><item>`, recursively resolving component references
down to mesh leaves:

- **Cycle detection** — an explicit ancestry `Set` per recursion branch
  (not a single global visited-set, which would incorrectly flag
  legitimate diamond-shaped reuse of the same object from two different
  branches as a cycle) → `THREEMF_COMPONENT_CYCLE`.
- **Depth limit** — `ThreeMFLimits.maxComponentDepth`, checked on every
  recursive step → `THREEMF_COMPONENT_DEPTH_EXCEEDED`.
- **Missing references** — a build item or component pointing at an
  object id that doesn't exist → `THREEMF_OBJECT_MISSING`.
- **Instance counting** — every time resolution reaches a mesh leaf
  (regardless of how many different build items/components led there),
  it counts as one component instance; `objectCount` in the result is
  the number of *distinct* mesh objects that contributed geometry, which
  can be smaller than `componentInstanceCount` when the same object is
  placed more than once.
- **A build item or reference is only followed, never assumed** — an
  object that exists in `<resources>` but is never referenced by any
  build item (directly or through components) contributes no geometry.
  An empty `<build>` is a hard error (`THREEMF_BUILD_EMPTY`), not a
  silent "export nothing."

### Transform convention and composition order

See the extensive comment on `parseTransform()` in
`src/lib/threemf/transforms.ts` for the exact per-coordinate formula.
Short version: a 3MF `transform` attribute's 12 numbers are **not** a
textbook row-major 3x3 rotation followed by a translation row — getting
this backwards (transposing the linear part) is the classic
row-major/column-major mistake, which is why
`transforms.test.ts` has dedicated tests verifying translate-then-scale
produces a *different* result than scale-then-translate, and that
composing a chain of three transforms matches applying them one at a
time in the same order.

`composeTransforms(inner, outer)` composes so that a point is
transformed by `inner` first, then `outer` — when flattening nested
components, each component's own transform is `inner` relative to
whatever has accumulated above it (`outer`), so recursion naturally
builds up "closest-to-the-leaf transform applied first" without needing
to reverse anything afterward.

### Reflected-transform handling

A transform with a negative determinant (`transformDeterminantSign()`)
mirrors geometry — `resolve-scene.ts` detects this per-triangle (based
on the *fully composed* transform reaching that triangle, not just the
build item's own transform) and swaps two of the triangle's three vertex
indices before emitting it, so the resulting winding — and therefore the
computed face normal — stays consistent with the rest of the scene
instead of pointing inward. `resolve-scene.test.ts`'s reflection test
verifies this numerically: without the swap, a mirrored triangle's naive
cross-product normal points the wrong way; with it, it points correctly
outward. This was verified against real, hand-computed geometry during
browser testing too (a multi-object, multi-instance, reflected-transform
fixture converted, and its reported bounding box matched a manual
by-hand calculation of the expected placement to the millimeter), not
just unit tests.

### Binary STL serialization

`src/lib/stl/serialize-binary.ts`'s `serializeBinarySTL()` is the exact
byte-layout inverse of `parse-binary.ts`: 80-byte header, little-endian
`uint32` triangle count, then per triangle a 50-byte record (3×`float32`
normal, 3×3×`float32` vertices, `uint16` attribute byte count fixed at
0). It validates that `positions.length` is a whole number of triangles,
rejects a triangle count beyond STL's unsigned-32-bit field, computes
normals via the shared `resolveNormals()` (from `src/lib/stl/normals.ts`)
when none are supplied, rejects any non-finite output value, and
sanitizes the header to printable ASCII truncated to 80 bytes — the
converter passes a fixed generic header ("MeshKit 3MF to STL
conversion"), never the original filename, sidestepping any need to
sanitize user-controlled text into that field at all. Round-trip tests
(`serialize-binary.test.ts`, and `convert.test.ts` at the full-pipeline
level) feed the serialized bytes back through the *existing, unmodified*
`parseBinarySTL()` and assert equivalent positions and bounds — and this
was additionally verified live in the browser by downloading a converted
file and opening it in `/stl-viewer/`, whose independently-built parser
reported the exact same triangle count and bounding box.

### Buffer ownership and transfer flow

`src/workers/threemf-to-stl.worker.ts` follows the same shape as
`stl-viewer.worker.ts`, with finer-grained progress stages
(`reading-package` → `validating-package` → `locating-model` →
`parsing-model` → `resolving-components` → `building-geometry` →
`serializing-stl` → `complete`) reflecting that 3MF conversion has
genuinely more distinct phases than STL parsing. The worker never sends
the original package buffer or any intermediate ZIP/XML structure back
to the main thread — only three things are transferred out:
`positions.buffer`, `normals.buffer` (for the preview), and `stlBuffer`
(the finished download). Everything else — the package's decompressed
entries, the parsed `ThreeMFModel`, the XML string — exists only in the
worker's local scope and is eligible for garbage collection the moment
`handleProcess()` returns.

### Download lifecycle

The output filename comes from `src/lib/files/download.ts`'s
`buildConvertedFilename(originalName, "3mf", "stl")` — deliberately
**not** the existing `sanitizeDownloadBasename()` (used for STL Viewer
screenshots), because this phase's filename examples
(`part.final.3mf` → `part.final.stl`) require *preserving* internal dots
that `sanitizeDownloadBasename()` would aggressively convert to hyphens.
`buildConvertedFilename()` strips only the trailing source extension,
removes genuinely unsafe characters (path separators, control
characters), strips any resulting leading dot (no hidden-file-style
output name), and falls back to `"model.stl"` if nothing safe remains.
The download itself follows the same `Blob` → `URL.createObjectURL` →
temporary `<a download>` → `.click()` → `URL.revokeObjectURL()` pattern
as STL Viewer's screenshot export. The STL buffer is held in the page's
client script only as `lastStlBuffer`, cleared (`disposeStlOutput()`) on
"Convert another file," on a new file replacing it, on a failed
conversion, and on `pagehide` — a failed conversion never leaves a
stale, downloadable result from a previous success.

### Unsupported features and conversion warnings

`model-parser.ts` records (but does not fail on) `<basematerials>`,
`<colorgroup>`, `<texture2d>` and `<metadata>` elements it encounters.
`resolve-scene.ts` turns these into non-blocking `ConversionWarning`s
shown in the UI before download — geometry still converts correctly;
only the unsupported-feature information is (honestly) reported as lost.
This is a deliberate distinction from the *blocking* errors
(`THREEMF_BUILD_EMPTY`, `THREEMF_GEOMETRY_EMPTY`, etc.), which represent
"there is nothing correct to export," not "some non-geometry data won't
carry over."

### Adding another converter

1. Add `src/lib/<format>/` for parsing, following `src/lib/threemf/`'s
   separation of concerns (container/package parsing, if any; format
   parsing; scene/geometry resolution) — keep each concern independently
   testable, as `package.test.ts`/`xml.test.ts`/`model-parser.test.ts`/
   `resolve-scene.test.ts` do here.
2. Reuse `src/lib/stl/serialize-binary.ts` if the target format is STL;
   add a sibling serializer for any other output format.
3. Create `src/workers/<format>-to-stl.worker.ts` on the existing
   protocol, with real (not fabricated) progress stages matching that
   format's actual processing phases.
4. Build the page on `ToolLayout`, reusing `LocalFilePicker`,
   `ToolStatus`, `ToolError`, `ToolViewport` — write a converter-specific
   info panel and controls inline in the page rather than forcing a fit
   into `ModelInfoPanel`/`ViewerControls` (those are STL-Viewer-shaped);
   extract a shared component only once a second converter's panel
   genuinely matches this one's shape.
5. Use `buildConvertedFilename()` for the output name unless a format
   has a different, documented naming convention.
6. Flip the registry `status` to `"ready"` only once every acceptance
   criterion for that specific converter passes — never mark an
   unrelated tool ready as a side effect.

## OBJ → STL Converter (Phase 3B)

`/obj-to-stl/` is the second converter and the first to parse a plain-text
(not binary, not XML/ZIP) format. It reuses the Phase 1/2 foundation and
Phase 3A's `src/lib/stl/serialize-binary.ts` / `normals.ts` /
`bounds.ts` unchanged — nothing in the STL Viewer or 3MF converter was
modified for this phase.

### Why OBJ parsing is a single forward pass, not "vertices then faces"

OBJ technically allows `v`/`vn`/`vt`/`f` statements to interleave, and
face-vertex indices may be negative — resolved **relative to however many
of that element exist at the point the face line is parsed**, not the
file's final totals. `src/lib/obj/parser.ts`'s `parseOBJDocument()` is
therefore one line-oriented forward pass: every `f` statement resolves
its indices immediately, against the vertex/texcoord/normal counts
accumulated so far. `parser.test.ts` has a dedicated regression test that
would fail if index resolution were accidentally deferred to a
two-pass/final-count model: two vertices exist when a face references
`-3` (out of range against 2), and three *more* vertices are added
afterward in the same file — a buggy "resolve against the final count"
implementation would wrongly accept it.

### Text decoding and tokenizing

`src/lib/obj/tokenizer.ts` decodes the buffer as UTF-8 (rejecting null
bytes and invalid UTF-8 outright — `OBJ_TEXT_DECODE_FAILED`), strips an
optional BOM, and normalizes CRLF/LF/CR line endings. A physical line
ending in a trailing `\` is merged with the next one (OBJ's line
continuation). Comments (`#`, full-line or trailing) are stripped before
whitespace-splitting into a keyword and argument list. Only fixed
(non-nested) `\s+`-style patterns are used — no regex here is vulnerable
to catastrophic backtracking regardless of input size.

### Vertex-line disambiguation policy

OBJ's `v` statement has no single canonical arity. Rather than guess,
`parser.ts`'s `parseVertexStatement()` applies one deterministic rule:
**3 fields** is `x y z`; **4 fields** is homogeneous `x y z w` (divided
through, rejecting a zero `w`); **6 fields** is the common (non-standard)
vertex-color extension `x y z r g b` — the color channels are validated
as numbers, then discarded, since STL has no per-vertex-color field, and
a `vertex-colors-not-preserved` warning is shown. **Any other field
count (5, or 7+) is rejected** (`OBJ_VERTEX_INVALID`) rather than
guessed at — a 7-field line could mean "x y z w r g b" or a mistyped
color line, and there is no OBJ convention that resolves the ambiguity.

### Face-reference parsing and closing-vertex normalization

`src/lib/obj/indices.ts` parses all four legal face-vertex forms (`v`,
`v/vt`, `v//vn`, `v/vt/vn`), rejecting index zero
(`OBJ_INDEX_ZERO`), an out-of-range index (`OBJ_INDEX_OUT_OF_RANGE`), and
any malformed separator (a bare trailing/leading slash, or more than
three slash-delimited fields — `OBJ_FACE_INVALID`). `parser.ts` then
**normalizes a single redundant closing reference** (`f 1 2 3 1` becomes
triangle `1 2 3`) but **rejects any other repeated vertex reference**
(`f 1 2 1 3`) as `OBJ_FACE_INVALID` — a face that collapses on itself
anywhere other than its own closing edge is treated as malformed input,
never silently deduplicated into different geometry than what was
written.

### Polygon triangulation

`src/lib/obj/triangulate.ts` never unconditionally fans a polygon (fan
triangulation corrupts concave shapes — see the module's own worked
example in `triangulate.test.ts`, where fanning a concave quad from
vertex 0 would emit a triangle with an *inverted* winding). The strategy:

1. A 3-vertex face returns unchanged (after a zero-area check).
2. A Newell-method polygon normal (stable even for near-degenerate
   input) picks a dominant projection axis. **When Newell's signed sum
   cancels to zero** — which happens not only for genuinely degenerate
   input but also for a *self-intersecting* polygon whose crossing loops
   wind in opposite directions (a "bowtie" is the textbook case) — the
   code falls back to a single triangle's cross product before
   concluding the polygon is truly degenerate, so a bowtie is correctly
   reported as `OBJ_POLYGON_SELF_INTERSECTING` rather than
   `OBJ_POLYGON_DEGENERATE`.
3. Every non-adjacent edge pair is checked for a 2D crossing
   (`hasSelfIntersection()`, O(n²), bounded by `maxFaceVertexCount`)
   **before** the area/convexity tests — for the same bowtie-cancellation
   reason above, this ordering matters.
4. A convex polygon (every vertex turn matches the polygon's own
   orientation) is fanned in O(n) — cheap and provably correct for
   convex input only.
5. A concave polygon is ear-clipped: repeatedly find a convex vertex
   whose ear triangle contains no other remaining vertex, emit it,
   remove it, repeat — deterministic (always scans from the current
   start) and bounded by `OBJLimits.maxTriangulationIterations`, so a
   pathological or already-invalid input fails safely
   (`OBJ_TRIANGULATION_FAILED`) instead of hanging the worker.

Output triangles are always expressed as index triples into the input
polygon's own vertex order — nothing here ever reverses vertex order, so
winding preservation is automatic rather than a separate correction
step. A polygon whose vertices deviate from its own best-fit plane by
more than a small tolerance is rejected (`OBJ_POLYGON_NON_PLANAR`); a
smaller deviation is accepted but reported as a `non-planar-faces`
warning — MeshKit does not claim perfect planarity preservation.

### Why declared `vn` values are never trusted for output

STL stores exactly one geometric normal per triangle and cannot express
OBJ's per-vertex smooth-shading interpolation. `vn` references are
parsed and validated for syntax (so a malformed `v//vn` face is still
caught), but the actual output normals are always recomputed from each
final triangle's own vertex positions via the shared
`src/lib/stl/normals.ts` — the same function the STL parser and the 3MF
scene resolver use, so face-normal math exists in exactly one place
across all three tools. A file that declares `vn` values or a non-off
smoothing group gets a `smooth-shading-converted` warning.

### Metadata, merging and unsupported-feature warnings

`o`/`g`/`s`/`mtllib`/`usemtl` are tracked but never fetched or resolved
— `mtllib`'s referenced `.mtl` file (and any other path an OBJ might
reference) is never requested, matching the "no upload, no external
fetch" privacy boundary. All geometry — regardless of how many objects
or groups it's split across — is merged into one output mesh, with a
`groups-merged` warning whenever more than one object or group was
present. `l`/`p` statements are counted and ignored
(`lines-ignored`/`points-ignored` warnings) when triangle geometry is
also present; a file containing **only** line/point primitives is a hard
error (`OBJ_UNSUPPORTED_GEOMETRY`), never silently converted into
arbitrary thin triangles or point-sprite meshes.

### Units: coordinates are preserved exactly, on purpose

Unlike 3MF (which declares an explicit unit) or STL (implicitly
unitless), OBJ has no unit concept at all. `convert.ts` never scales a
coordinate by any factor — the page's copy states this explicitly, and
dimensions are shown as plain numbers ("model units"), never labeled
millimeters. This is a deliberate design choice, not a missing feature.

### Worker pipeline and buffer ownership

`src/workers/obj-to-stl.worker.ts` uses honest, single-pass-matching
progress stages — `reading` → `decoding` → `parsing` →
`building-geometry` → `serializing-stl` → `complete` — rather than
inventing a separate "vertices"/"faces" split that Phase 3B's own
single-pass parser doesn't actually have. As with the 3MF worker, only
`positions.buffer`, `normals.buffer` and `stlBuffer` are transferred back
to the main thread; the decoded source text and every intermediate
parsing structure exist only in the worker's local scope.

### Verified live in the browser, not just in unit tests

Beyond the 271 unit tests, this phase was round-tripped end-to-end: a
generated OBJ converts to STL, downloads, and — independently — opens
correctly in `/stl-viewer/`, whose separately-built parser reports the
same triangle count and bounding box. A ~9 MB, 230,400-quad grid fixture
(460,800 output triangles) converted correctly and quickly, confirming
the ear-clipping/fan fast-path split scales well beyond hand-written
test fixtures. Cancellation was verified by generating a ~40 MB,
1,000,000-quad fixture, cancelling mid-`decoding`, and confirming the
UI reaches a clean `Cancelled` state with no stale preview or download.

## GLB → STL Converter (Phase 3C)

`/glb-to-stl/` is the third converter and the first to parse a binary
container wrapping a full scene graph (nodes, transforms, mesh
instancing) rather than a flat build-item list (3MF) or a single
implicit mesh (OBJ). It reuses the Phase 1/2 foundation and
`src/lib/stl/serialize-binary.ts`/`normals.ts`/`bounds.ts` unchanged —
nothing in the STL Viewer, 3MF converter or OBJ converter was modified
for this phase.

### GLB container validation

`src/lib/glb/container.ts` validates the 12-byte header (magic
`0x46546C67`, version `2`, declared total length required to equal the
buffer's *actual* length exactly — catching both "claims to be bigger
than it is" and "has trailing undeclared bytes" with one check) before
walking chunks. Each chunk header's declared length is checked against
the remaining buffer size — never trusted — before that chunk's bytes
are read; a JSON chunk not appearing first, a duplicate JSON or BIN
chunk, or a non-4-byte-aligned chunk length are all rejected. An unknown
chunk type is skipped without its bytes ever being interpreted, per the
glTF spec's own "clients must ignore unrecognized chunks" rule.

### glTF JSON: native `JSON.parse`, not a hand-rolled parser

Unlike 3MF's XML (hand-tokenized specifically to close off XXE), glTF's
JSON chunk is parsed with the browser's native `JSON.parse` —
`src/lib/glb/schema.ts` explains why this is safe (no external-entity
equivalent risk, and V8's parser is itself a well-tested dependency) but
never trusts the *shape* of what comes back: every array this converter
reads is length-capped against `GLBLimits` immediately after parsing,
and every field the converter actually uses is type/range-checked
(finite numbers, non-negative integers, matching array bounds) before
any other module is allowed to assume it's safe.

### Buffer views and accessors: stride, alignment, sparse overrides

`src/lib/glb/accessors.ts`'s `resolveBufferView()` validates a
bufferView's buffer index (only buffer 0 — the GLB's own embedded BIN
chunk — is supported; anything else, or any buffer declaring a `uri`, is
rejected as `GLB_EXTERNAL_BUFFER_UNSUPPORTED` without ever calling
`fetch`), byte range, and `byteStride` (glTF's 4–252 byte, multiple-of-4
range). `readAccessorRaw()` then decodes every element — respecting
interleaved stride when present, defaulting to tightly-packed layout
otherwise, and validating the *last byte the last element touches*
against the buffer view's real length (not just `count * elementSize`,
which strided data would under-count). Sparse accessors are fully
supported: a missing `bufferView` means an implicit all-zero base (per
spec), and `applySparse()` overrides specific elements afterward,
rejecting an out-of-range or duplicate sparse index rather than
guessing which override should win.

### Positions and indices: what's supported, and what's deliberately not

`readPositionAccessor()` requires floating-point `VEC3` — `KHR_mesh_quantization`'s
normalized/integer position encodings are **not implemented**; a
non-float position accessor is rejected with `GLB_ACCESSOR_TYPE_UNSUPPORTED`
rather than misread as a float. `readIndexAccessor()` accepts only the
three unsigned integer component types glTF permits for indices
(`UNSIGNED_BYTE`/`UNSIGNED_SHORT`/`UNSIGNED_INT`) and rejects signed or
floating-point index accessors outright.

### Primitive modes and triangulation

`src/lib/glb/primitives.ts` decodes every mesh's primitives **once**,
up front — independent of how many scene nodes go on to instance that
mesh, so a shared accessor is never re-read from its buffer view more
than once. `TRIANGLES` requires an element count divisible by three and
preserves index order; `TRIANGLE_STRIP` produces one triangle per
element after the first two, alternating winding every other triangle;
`TRIANGLE_FAN` fans from the first vertex. `POINTS`/`LINES`/`LINE_LOOP`/`LINE_STRIP`
are skipped with a tracked, counted warning (never misrepresented as
surfaces); a primitive mode outside 0–6 entirely is rejected as
`GLB_PRIMITIVE_MODE_UNSUPPORTED`. A primitive using
`KHR_draco_mesh_compression` is rejected immediately — including when
the extension isn't globally required, since this converter never
attempts to read compressed bytes through the normal accessor path
(that includes a "fallback" set of regular accessors some Draco-using
files declare alongside the compressed data: MeshKit doesn't read those
either, since using them would silently diverge from the file's
intended compressed geometry).

### Scene selection: a documented, tested fallback

`src/lib/glb/resolve-scene.ts`'s `selectRootNodeIndices()` uses the
declared default scene (`scene` index, or `scenes[0]` when `scene` is
omitted but a `scenes` array exists — the spec's own fallback rule).
When a file has **no** `scenes` array at all, MeshKit falls back to
every node that is never referenced as another node's child — an
explicit, tested policy, not a blind "export every mesh resource in the
file." A file with no nodes to anchor to at all (or where every node is
someone's child, indicating a cycle with no true root) is rejected with
`GLB_SCENE_MISSING` rather than guessing.

### Node-graph traversal: cycle detection, depth limits, instancing

Node traversal mirrors 3MF's component-resolution shape: an ancestry
`Set` per recursion branch (not one global visited-set, which would
wrongly flag legitimate multi-parent mesh reuse as a cycle) catches a
genuine `GLB_NODE_CYCLE`, `GLBLimits.maxSceneDepth` bounds recursion
depth, and `GLBLimits.maxSceneInstances` bounds how many node-mesh
visits a scene can produce — since the *same* mesh may legitimately be
instanced by any number of different nodes, and each instance is
transformed and emitted independently.

### Transform math: column-major, `T × R × S`, NOT 3MF's row-vector convention

`src/lib/glb/transforms.ts` is a deliberately separate implementation
from 3MF's `transforms.ts` — see the extensive module-level comment
there for why. glTF's `matrix` is a 16-number **column-major** 4x4
(element `[col*4+row]` — conveniently, the same layout three.js's
`Matrix4.elements` uses), and a TRS node composes as `T × R × S`
(scale first, then rotate, then translate). `multiplyMat4(parentWorld,
local)` composes so that `local` applies to a point first and
`parentWorld` second — the standard parent-to-child scene-graph order.
`transforms.test.ts` has dedicated tests that would fail on a
row-major/column-major mixup, a reversed TRS order, a reversed
parent/child multiplication order, or a quaternion component-order
mistake (`[x,y,z,w]`, glTF's own order) — the same category of mistake
3MF's `transforms.test.ts` guards against for its own, differently-shaped
convention.

### Reflection and winding, unit scaling, degenerate triangles

`resolve-scene.ts`'s `emitPrimitiveTriangles()` follows the exact
pattern 3MF's `emitTriangle()` established: `determinantSign3x3()` on
the fully-composed world matrix detects a mirroring transform, and two
vertex indices are swapped before emitting so the resulting winding (and
computed face normal) stays outward-facing instead of flipping inward.
Metre-to-millimetre scaling (`METERS_TO_MILLIMETERS = 1000`) is applied
exactly once, after the world transform, in `transformAndScale()` — the
same "convert after composing transforms, in the model's native unit
space" ordering 3MF's `units.ts` conversion uses. A triangle whose
recomputed face normal is the zero vector after transformation (the
shared `computeFaceNormal()`'s signal for "zero area") is skipped,
counted (`skippedDegenerateTriangles`), and surfaced as a non-blocking
warning — never silently dropped without being reported, and never
treated as a mesh-repair operation.

### Compression and required-extension handling

`src/lib/glb/convert.ts`'s `checkRequiredExtensions()` runs immediately
after schema parsing, before any accessor is touched: `KHR_draco_mesh_compression`
and `EXT_meshopt_compression` in `extensionsRequired` produce their own
specific errors (`GLB_DRACO_UNSUPPORTED`/`GLB_MESHOPT_UNSUPPORTED`), and
any other required-but-unrecognized extension produces
`GLB_EXTENSION_REQUIRED_UNSUPPORTED` — so an unsupported-but-required
extension never produces silently-incomplete output. An extension that
is merely *used* (not required) is ignored as long as core geometry
still decodes; `EXT_meshopt_compression` is additionally checked
per-bufferView (`resolveBufferView()`), since it can replace a single
bufferView's data without being declared as a file-wide requirement.

### Worker pipeline and buffer ownership

`src/workers/glb-to-stl.worker.ts` follows the same shape as the 3MF and
OBJ workers, with progress stages matching the spec's suggested list
(`reading-container` → `validating-header` → `parsing-json` →
`validating-resources` → `reading-accessors` → `resolving-scene` →
`building-geometry` → `serializing-stl` → `complete`). Container framing
and JSON-schema validation are both single-pass, cheap steps handled by
one `parseGLB()` call — the "validating-header"/"parsing-json" progress
messages bracket that one call rather than corresponding to two
literally separate function invocations, the same fine-grained-but-honest
compromise 3MF's "locating-model"/"parsing-model" stages make. Only
`positions.buffer`, `normals.buffer` and `stlBuffer` are transferred
back to the main thread; the decoded JSON text, the parsed
`GLTFDocument`, and every intermediate accessor/bufferView slice exist
only in the worker's local scope.

### Verified live in the browser, not just in unit tests

Beyond the 388 unit tests, this phase was round-tripped end-to-end in a
real browser: a generated GLB converts to STL, downloads, and —
independently — opens correctly in `/stl-viewer/`, whose separately-built
parser reports the same triangle count and bounds. Unit conversion was
confirmed numerically (a 1-metre and a 6-metre triangle produced exactly
1000mm/6000mm output width). A reflected node's *downloaded STL bytes*
were inspected directly (not just the in-memory result) to confirm the
winding-correction fix produces an outward-facing facet normal matching
the unreflected case. A ~3.5 MB, 204,800-triangle indexed grid fixture
converted correctly; cancellation was verified by generating the same
scale of fixture, cancelling mid-flight, and confirming a clean
`Cancelled` state with no stale preview or download. External-buffer and
Draco-required fixtures were confirmed to produce zero network requests
before failing with their specific error codes.

## STL → OBJ Converter (Phase 3D)

`/stl-to-obj/` is the fourth converter and the first that **reads** the
existing STL parser's output and **writes** another format — every prior
converter's direction was "parse some other format, write STL." It
reuses `src/lib/stl/parse.ts`/`parse-binary.ts`/`parse-ascii.ts`
completely unchanged (the exact same parser `/stl-viewer/` uses), and
adds new OBJ **writer** infrastructure alongside the existing OBJ
*reader* infrastructure from Phase 3B.

### Where the new code lives, and why

Three small, independently testable modules were added under the
existing `src/lib/obj/` directory — `number-format.ts`, `deduplicate.ts`,
`serialize.ts` — rather than a new top-level directory, because they are
generic OBJ-writing infrastructure any future OBJ-producing tool could
reuse, exactly the same way `src/lib/stl/serialize-binary.ts` (the STL
*writer*) already lives alongside `parse-binary.ts`/`parse-ascii.ts`
(the STL *reader*) in `src/lib/stl/`, sharing `src/lib/stl/errors.ts`
between both directions. `src/lib/obj/errors.ts`'s existing
`OBJParseException`/`objError()` (previously used only by the Phase 3B
*parser*) is reused as-is for every new write-side `OBJ_*` code too —
the "ParseException" name is a pre-existing minor misnomer once it also
covers serialization failures, matching the same looseness
`STLParseException` already has (it's thrown by `serialize-binary.ts`
too). `src/lib/stl-to-obj/` holds only what's genuinely specific to
*this* pipeline: orchestration (`convert.ts`), the two error codes that
don't fit the `OBJ_*` template (`errors.ts`), result/limit types
(`types.ts`), and test fixtures.

### A collision in the spec's suggested error codes, resolved by scoping

The originally suggested code list included a new write-side
`OBJ_VERTEX_LIMIT_EXCEEDED` — but Phase 3B already defined a
*different* `OBJ_VERTEX_LIMIT_EXCEEDED` for the OBJ *parser* (too many
vertices in an OBJ file being read). Reusing the same code for two
unrelated meanings would make `SafeError.message` lie about which
direction failed. Resolved by renaming the new one to
`OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED` — still within the `OBJ_*` namespace
(so `src/lib/obj/deduplicate.ts` can throw it via the existing
`objError()` without importing anything from `src/lib/stl-to-obj/`,
preserving the layering described above), but unambiguous. Every other
suggested code was free of collisions and used as given.

### Exact-only vertex deduplication

`src/lib/obj/deduplicate.ts` merges two vertices only when their
coordinates are **bit-for-bit identical float32 values** — keyed by each
component's raw bit pattern (`DataView.getInt32` over a reused 4-byte
scratch buffer), not a decimal string, so no formatting choice could
ever cause an accidental key collision or miss. `-0` and `0` are
normalized to the same bit pattern before keying (tested explicitly),
so a coordinate that happens to be signed-zero doesn't spuriously
prevent a merge. There is **no distance tolerance** anywhere in this
path — a vertex `1e-7` units away from another is always kept distinct,
by design; welding "close enough" vertices is mesh repair, explicitly
out of scope for a format converter. A `Map` (amortized O(1)
lookup/insert) keeps this linear in vertex count regardless of mesh
size, and first-occurrence order is preserved deterministically.

### Float32 → decimal text: precision policy

`src/lib/obj/number-format.ts`'s `formatFloat32()` tries increasing
significant-digit counts (1 through 9) and keeps the **shortest** one
that still round-trips exactly back to the same float32 bit pattern via
`Math.fround`. Nine significant digits is the standard guaranteed
round-trip bound for IEEE-754 binary32 — this function never needs more,
and usually needs far fewer (an integer coordinate like `42` formats as
`"42"`, not `"42.0000000"`). `-0` formats as `"0"`. Non-finite input
throws `OBJ_NON_FINITE_OUTPUT` — the STL parser already rejects
non-finite vertices on input, so reaching this is a defense-in-depth
backstop, not an expected path.

### Degenerate-triangle policy

`src/lib/stl-to-obj/convert.ts`'s `filterDegenerateTriangles()` drops
any triangle whose already-resolved normal (from `resolveNormals()`,
the same shared function every converter uses) is the zero vector —
`src/lib/stl/normals.ts`'s signal for "zero area." Skipped triangles are
counted and surfaced as a `degenerate-triangles-skipped` warning; a file
where *every* triangle is degenerate fails fast with
`OBJ_NO_OUTPUT_GEOMETRY` before any deduplication or serialization work
runs. This is explicitly **not** mesh repair — MeshKit never invents
geometry to fill the gap a removed triangle leaves.

### One normal per face, `s off`, no invented materials

Every output triangle gets exactly one `vn` line (the resolved
geometric normal, never a raw/possibly-untrustworthy STL facet normal),
referenced from its face as `f a//n b//n c//n` — vertex and normal
indices only, no texture-coordinate slot, since nothing upstream
produces UVs. `s off` is always present. The OBJ never contains
`mtllib`, `usemtl`, the source filename, or any STL header text — the
object name is one fixed, sanitized constant (`MeshKit_Converted`), not
derived from anything user-controlled.

### Cancellation during large loops, not just between stages

Every prior worker only checks cancellation *between* pipeline stages —
sufficient when each stage itself is fast, but this phase's
deduplication and serialization loops can each be the single most
expensive part of the whole pipeline for a large mesh. A new shared
primitive, `src/lib/cancellation.ts`'s `yieldIfCancelled(index, every,
isCancelled)`, is called on every loop iteration but only actually
`await`s a real macrotask (letting the worker's message handler run,
so a `cancel` message sent while the loop is executing can actually be
observed) every `every`-th call — cheap enough to call unconditionally,
and tuned so an ordinary-sized mesh never yields even once. Deliberately
NOT tied to any specific converter's `ErrorCode` prefix (`CancellationRequested`
is format-agnostic), so `src/lib/obj/deduplicate.ts`/`serialize.ts` —
generic writer infrastructure — never need to import a specific
converter's error vocabulary just to support cancellation. The worker
catches `CancellationRequested` specifically and reports it as a
`cancelled` response, never a `SafeError` — this was verified live by
cancelling mid-`Deduplicating vertices…` on a 204,800-triangle fixture
and confirming a clean `Cancelled` state (not an error).

### Worker pipeline and staged progress

`src/workers/stl-to-obj.worker.ts` calls `src/lib/stl-to-obj/convert.ts`'s
individual pieces directly — `parseSTL()`, `filterDegenerateTriangles()`,
`deduplicateStep()`, `serializeStep()` — posting an honest progress
message between each, plus four more fine-grained stages
(`writing-vertices` → `writing-normals` → `writing-faces` →
`encoding-obj`) reported via an `onStage` callback `serializeOBJ()`
accepts specifically so the worker can surface real sub-phase progress
without `serialize.ts` needing to know anything about the worker
protocol. Only `positions.buffer`, `normals.buffer` and the OBJ
`ArrayBuffer` are transferred back; the dedup `Map`, the line-array text
builder, and the decoded STL structures all stay local to the worker
function and become eligible for garbage collection once it returns.

### Verified live in the browser: the full round trip

Beyond the 437 unit tests (including generating the OBJ text, re-parsing
it with the *production* Phase 3B OBJ parser, and asserting equivalent
triangle count and bounds), this phase was verified end to end across
**three** separate converter pages in one browser session: a two-triangle
quad STL converted to OBJ on `/stl-to-obj/`, the exact downloaded OBJ
bytes fed into `/obj-to-stl/` (which parsed it and reported identical
vertex/face/dimension counts), the STL it produced downloaded and opened
in `/stl-viewer/` — reporting the identical triangle count and bounding
box as the very first STL. A 204,800-triangle, ~10 MB generated grid
fixture (with heavy intentional vertex sharing) converted correctly in
about two seconds, correctly reporting 103,041 unique vertices and
511,359 duplicate references removed.

## STL → 3MF Converter (Phase 3E)

`/stl-to-3mf/` is the fifth converter and the second (after Phase 3D)
that reads the existing STL parser's output and writes another format.
It reuses `src/lib/stl/parse.ts` unchanged, `src/lib/stl/degenerate.ts`
and `src/lib/mesh/{deduplicate,number-format}.ts` as-is (see below), and
the existing 3MF *reader* — `package.ts`, `relationships.ts` — for
verification, both in tests and by construction (the writer imports two
of the reader's own constants directly, so they can never drift apart).

### Extracting the format-neutral dedup/format helpers into `src/lib/mesh/`

Phase 3D's `deduplicateVertices()` and `formatFloat32()` lived under
`src/lib/obj/` — reasonable when only the OBJ writer needed them, but
genuinely format-neutral (nothing about "merge bit-identical float32
vertices" or "format a float32 as minimal round-trippable decimal text"
is specific to OBJ). Rather than duplicate either implementation for the
3MF writer, both moved to a new `src/lib/mesh/` directory as the
canonical home, with `src/lib/obj/{deduplicate,number-format}.ts`
becoming thin compatibility wrappers that preserve **every** existing
caller's exact behavior — including the specific `OBJ_*` error codes
`src/lib/stl-to-obj/convert.ts` and the existing test suite already
depend on. The generic `src/lib/mesh/errors.ts` (`NonFiniteCoordinateError`,
`UniqueVertexLimitExceededError`) is deliberately not tied to any
converter's `ErrorCode` prefix; each domain (`src/lib/obj/`, this
phase's `src/lib/stl-to-threemf/convert.ts`) catches these generic types
at its own boundary and translates them into its own specific code
(`OBJ_NON_FINITE_OUTPUT` vs `THREEMF_NON_FINITE_OUTPUT`, etc.). This is
exactly option 2 from this phase's own instructions ("move it into a
shared mesh module with a compatibility re-export and regression
tests") — validated by the fact that every one of Phase 3D's original
`obj/deduplicate.test.ts`/`obj/number-format.test.ts` tests still passes
unchanged against the new wrapper, alongside new `mesh/deduplicate.test.ts`/
`mesh/number-format.test.ts` tests exercising the canonical module's
generic-error behavior directly.

`filterDegenerateTriangles()` (STL-specific, not OBJ-specific — it
operates on `STLParseResult`, has no error-code coupling of its own, and
is used identically by both writers) similarly moved to
`src/lib/stl/degenerate.ts`, with `src/lib/stl-to-obj/convert.ts`
re-exporting it for the same backward-compatibility reason.

### Model XML: a fixed schema, not a general serializer

`src/lib/threemf/model-writer.ts` emits exactly the structure the 3MF
core spec requires for this converter's scope — one `<resources>`, one
`<object>`, one `<mesh>`, indexed `<vertices>`/`<triangles>`, one
`<build><item>` — as an array of element strings joined once (never
`+=` concatenation), the same anti-quadratic strategy `src/lib/obj/serialize.ts`
uses for OBJ text. Every element/attribute *name* is a fixed constant;
the only *values* are `formatFloat32()`-formatted numbers (which can
never contain an XML-special character) and one fixed object id.
`src/lib/threemf/xml-escape.ts`'s `escapeXmlAttribute()` is applied to
the id anyway — not because it's currently necessary, but so a future
phase that adds genuinely user-derived text (an object name, say) has an
already-tested escaping path ready, rather than needing to invent one
under time pressure. Coordinates use the exact same `formatFloat32()`
Phase 3D established — one formatting policy for the same kind of
`Float32Array` geometry, regardless of which text format it's rendered
into.

### The one real naming collision, and how it differed from Phase 3D's

Unlike Phase 3D (which had to rename one colliding code), every
suggested `THREEMF_*` writer-side code in this phase's error list was
already collision-free against the existing *reader's* codes, and — more
usefully — `src/lib/threemf/errors.ts`'s existing `ThreeMFErrorCode`
type (`Extract<ErrorCode, 'THREEMF_${string}'>`) automatically covers
every new writer code too, purely from adding them to the shared
`ErrorCode` union. `threeMFError()`/`ThreeMFParseException` — already
used by the reader, and already the exact pattern `STLParseException`
established for STL's own reader/writer split — needed zero changes to
support the writer. Only the two pipeline-specific codes
(`STL_TO_THREEMF_DEDUPLICATION_FAILED`/`STL_TO_THREEMF_CANCELLED`, which
don't start with `THREEMF_`) needed their own small `STLToThreeMFException`
in `src/lib/stl-to-threemf/errors.ts` — mirroring `STLToOBJException`
from Phase 3D exactly.

### Millimetre declaration: a stated policy, not a detected fact

3MF requires every package to declare a unit; STL has no unit field at
all. `convertSTLToThreeMF()` always sets `declaredUnit: "millimeter"`
and `coordinateScale: 1` — the coordinate values themselves are never
multiplied by anything. The UI states this as plainly as the result
type does: "Input units: unknown / Output declaration: millimetres /
Coordinate scaling: none," never implying MeshKit detected the source
file's real-world scale. This is a different unit story from every
other converter so far — GLB has a real source unit (metres, scaled
×1000), OBJ has no unit concept and declares nothing, and 3MF *reading*
(Phase 3A) trusts the package's own declared unit — Phase 3E is the only
case where MeshKit itself is the one declaring a unit for data that
never had one.

### ZIP writing: `fflate`, not hand-rolled — and a real bug this caught

`src/lib/threemf/package-writer.ts` uses `fflate`'s `zipSync()` directly,
unlike the ZIP *reader* (`package.ts`, hand-rolled specifically to
inspect encryption flags fflate's high-level read API hides) — MeshKit
controls every byte being written here, so there's no untrusted-input
safety case to hand-roll around. A fixed `mtime` is passed so identical
geometry produces byte-identical package output across runs (verified by
`package-writer.test.ts`). **A real bug found during implementation:**
the first attempt used `new Date(0)` (the Unix epoch, 1970) as that fixed
timestamp — `zipSync()` threw `"date not in range 1980-2099"` on every
single call, since ZIP's DOS-style timestamp field can't represent
anything before 1980. Fixed by using a fixed date safely inside that
range (`2000-01-01T00:00:00Z`) instead; caught immediately by running
`package-writer.test.ts`, before this ever reached browser testing.

### Worker pipeline and lightweight output verification

`src/workers/stl-to-threemf.worker.ts` calls
`parseSTL()`/`filterDegenerateTriangles()`/`deduplicateStep()`/`writeModelXML()`/
`writeThreeMFPackage()`/`verifyPackageOutput()` directly, posting a
progress message between each — nine stages in total, matching the
spec's suggested list. `verifyPackageOutput()` is deliberately cheap
(package non-empty, XML non-empty, size under the ceiling) rather than a
full re-parse through the production reader — round-tripping through
`openThreeMFPackage()`/`parseThreeMFModel()`/`resolveScene()` on every
single conversion would materially double the cost for a large model;
that full verification instead lives in tests (which do it on every
run) and was additionally confirmed live in the browser.

### Verified live in the browser: the full four-tool round trip

Beyond the 500 unit tests (including opening every generated package
with `openThreeMFPackage()`/`findPrimaryModelPath()`/`parseThreeMFModel()`/
`resolveScene()` — the actual production reader, not a parallel
verification implementation), this phase was verified end to end across
**three** separate converter pages in one browser session: a
two-triangle quad STL converted to 3MF on `/stl-to-3mf/`, the exact
downloaded package fed into `/3mf-to-stl/` (which opened it and reported
`sourceUnit: Millimeter` — confirming the declaration round-trips — and
identical triangle/dimension counts), the STL it produced downloaded and
opened in `/stl-viewer/` — reporting the identical triangle count and
bounding box as the very first STL. A 204,800-triangle, ~10 MB generated
grid fixture converted correctly in about four seconds, producing a 1.2
MB compressed package (smaller than the equivalent OBJ output from the
identical Phase 3D fixture, since indexed XML plus ZIP compression is
more compact than OBJ's plain-text line format) with the same
103,041-unique-vertex/511,359-duplicate-removed result Phase 3D's
identical source mesh produced.

## PLY → STL Converter (Phase 3F)

`/ply-to-stl/` is the sixth and final Phase 3 converter, and — like
3MF→STL, OBJ→STL and GLB→STL — reads a foreign format and writes STL via
the unchanged `src/lib/stl/serialize-binary.ts`. Its own module lives at
`src/lib/ply/`: `types.ts`, `errors.ts`, `scalar-types.ts`, `header.ts`,
`scalar-reader.ts`, `ascii-reader.ts`, `binary-reader.ts`, `properties.ts`,
`triangulate.ts`, `parser.ts`, `convert.ts`, `formatting.ts`, plus a
`test-fixtures.ts` that builds real ASCII and binary PLY buffers from a
small element/row description rather than hand-rolled byte arrays.

### A self-describing header, not a fixed record layout

Unlike STL's binary-vs-ASCII *detection* problem (no explicit
declaration — `src/lib/stl/detect.ts` cross-checks the declared triangle
count against buffer length), PLY states its own encoding directly in a
human-readable header (`format ascii 1.0` / `format binary_little_endian
1.0` / `format binary_big_endian 1.0`), and declares an arbitrary,
file-specific list of elements and properties (`element vertex 8` /
`property float x` / ... / `element face 6` / `property list uchar int
vertex_indices`). `header.ts` parses this directly against the raw byte
array (never a full `TextDecoder.decode()` of the whole buffer) because
whatever immediately follows the `end_header` line is the file's BODY,
which may be raw binary — the header parser has to return the *exact*
byte offset the body starts at, tolerating LF/CRLF/CR line endings within
one pass over the bytes.

### One `ScalarReader` interface, two implementations

`scalar-reader.ts` defines a tiny `ScalarReader` interface
(`next(type): number`) that `parser.ts` programs against uniformly,
regardless of encoding — `ascii-reader.ts`'s implementation reads from a
flattened whitespace-token stream (deliberately not enforcing PLY's
conventional one-row-per-line layout, so a stray extra newline never
causes a spurious rejection), and `binary-reader.ts`'s implementation
reads from a `DataView` cursor with an explicit `littleEndian` flag
threaded through every read — the one difference between
`binary_little_endian` and `binary_big_endian`. This abstraction is also
what makes safe skipping possible: reading an element or property this
converter doesn't use still calls `next()` the schema-declared number of
times, so the shared cursor never desyncs for the elements/properties
that follow it. `properties.ts` resolves the header's schema into what
the converter actually needs — the `vertex` element's `x`/`y`/`z`
properties (by name, at whatever position they appear) and the `face`
element's `vertex_indices` (or `vertex_index` alias) list property —
and classifies everything else as a recognized-but-dropped kind (color,
normal, texture coordinate) or a genuinely unknown one, counted for an
aggregated warning rather than one warning per field.

### Reusing OBJ's triangulation via the Phase 3E extraction pattern

This phase's own instructions asked for exactly the pattern Phase 3E
established for `deduplicate.ts`/`number-format.ts`: don't duplicate
`src/lib/obj/triangulate.ts`'s polygon triangulation algorithm. It moved
to `src/lib/mesh/triangulate.ts` as the canonical, format-neutral
implementation — same convex-fan/concave-ear-clip/self-intersection
logic, byte-for-byte — throwing five new generic exceptions
(`FaceTooSmallError`, `PolygonDegenerateError`, `PolygonNonPlanarError`,
`PolygonSelfIntersectingError`, `TriangulationFailedError`) added to
`src/lib/mesh/errors.ts` alongside Phase 3E's
`NonFiniteCoordinateError`/`UniqueVertexLimitExceededError`.
`src/lib/obj/triangulate.ts` is now a thin wrapper preserving its exact
pre-3F public API and exact `OBJ_*` error codes; `src/lib/ply/triangulate.ts`
is a second, equally thin wrapper translating the same generic errors
into `PLY_*` codes. The existing `src/lib/obj/triangulate.test.ts` suite
passes unchanged against the new wrapper — the explicit regression check
this phase's instructions required — alongside a new
`src/lib/mesh/triangulate.test.ts` exercising the canonical module's
generic-error behavior directly, and `src/lib/ply/triangulate.test.ts`
exercising the PLY-side translation.

### Point clouds are rejected, not surfaced with an invented mesh

A PLY file can legitimately contain only a `vertex` element — a raw
point cloud, common straight off a 3D scanner before surface
reconstruction. `resolvePLYSchema()` requires a `face` element with a
usable `vertex_indices`/`vertex_index` list property before any body
byte is read, rejecting a point-cloud-only file with
`PLY_FACE_ELEMENT_MISSING` immediately rather than reading (and
discarding) potentially large vertex data first. A `face` element that's
declared but structurally empty (`element face 0`) is allowed through
schema validation and only rejected at the end, once triangle count is
known to be zero (`PLY_NO_FACE_GEOMETRY`) — mirroring
`buildOBJGeometry()`'s own `OBJ_NO_FACE_GEOMETRY`/`OBJ_EMPTY_GEOMETRY`
split exactly.

### Float64 narrowing is disclosed, not silently absorbed

STL only stores single-precision (float32) coordinates. When a PLY
file's `x`/`y`/`z` vertex properties are declared `double` (float64),
`readVertexElement()` flags this (tracking it only for the coordinate
properties specifically, not any other `double` field on the vertex
element, such as a per-vertex confidence value) and `buildPLYGeometry()`
surfaces a `double-precision-narrowed` warning — an unavoidable,
disclosed precision loss rather than a silent one.

### Worker staging: honest about what's actually one pass

`src/workers/ply-to-stl.worker.ts` splits `parser.ts` into
`resolvePLYSchema()` (header parsing + schema resolution — a real,
separate pass from reading the file's body) and `readPLYBody()` (the
single forward pass that reads vertex coordinates, triangulates face
polygons, and skips everything else, in header order). Vertex reading,
face reading and face triangulation are genuinely interleaved in that one
pass — each face is triangulated immediately after its own index list is
read, the same way OBJ's own single-pass parser interleaves face parsing
and triangulation (see `src/workers/obj-to-stl.worker.ts`'s module
comment) — so the worker reports them as one `"reading-geometry"` stage
rather than three separately-named ones that don't actually happen
separately.

### Verified live in the browser

Beyond the 584-test suite (74 of them new to this phase, covering header
grammar, all 8 scalar types and their aliases in both endiannesses,
arbitrary property order, vertex/face extraction rules, ambiguous/missing
index-property rejection, unknown-element/property skipping with
byte/token alignment preserved, Float64 narrowing, and the OBJ
triangulation regression check), this phase was verified live in a
browser session: an ASCII quad (4 vertices, 2 polygon-triangulated faces)
converted correctly; a `binary_big_endian` file with vertex colors *and*
an unrecognized `edge` element declared *before* the `vertex` element in
the header converted correctly too — confirming both big-endian byte
reads and safe skip-and-realign past an unknown element mid-file — with
the expected `vertex-colors-not-preserved` and `unknown-elements-skipped`
warnings both rendered; a point-cloud-only file and a file with an
ambiguous (`vertex_indices` + `vertex_index` both present) face element
were both rejected with their specific, correct error messages; the
converted quad's downloaded STL was fed into `/stl-viewer/` — the
production STL reader — and reported the identical 2-triangle count and
(0,0,0)–(2,2,0) bounding box as the source; and the page rendered with no
horizontal overflow at a 375px mobile viewport width.

## OBJ Viewer (Phase 4A)

### A second orchestration layer over the reader, not a second parser

`buildOBJGeometry()` (the converter's own pipeline) intentionally discards
everything a viewer needs beyond triangle geometry: actual `vn` values
(only their syntax is validated), which normal a given face corner
referenced, object/group/material/smoothing-group boundaries, and `l`/`p`
statements (counted, never resolved to positions). Re-deriving all of that
from the converter's own output would be impossible after the fact,
so `src/lib/obj/viewer-geometry.ts` runs its own single forward pass —
required for the same reason `parseOBJDocument`'s is single-pass: OBJ's
negative indices resolve against counts available *at that point in the
file*, not the file's final totals, so vertices/faces/normals/lines/points
genuinely have to be walked together in one pass, in source order.

Every low-level primitive that pass uses, though, is imported directly
from the production parser rather than reimplemented: `iterateLogicalLines`/
`tokenizeLine` (tokenizer.ts), `parseFaceVertexToken`/`resolveIndex`/
`parseIndexInt` (indices.ts), `triangulatePolygon` (triangulate.ts), and
`parseVertexStatement`/`assertFiniteTriplet`/`assertMagnitude`/
`isSmoothingOff`/`dedupeClosingVertex`/`assertNoCollapsedVertices`/
`parseFloatToken` (parser.ts — exported additively for this reuse; their
behavior is otherwise byte-for-byte unchanged, and `/obj-to-stl/`'s own
test suite is the regression guard for that). This guarantees the viewer
can never disagree with the converter about what a given vertex, face or
index means, while still being free to keep information the converter
throws away.

### Segments: lazy, boundary-triggered, never empty

A "segment" is a maximal contiguous run of triangles sharing the same
object name, group-name set, material reference and smoothing group. The
parser doesn't proactively open a segment on every `o`/`g`/`usemtl`/`s`
statement — a trailing `g` with no faces after it must not produce an
empty entry — instead, each `f` statement computes the current state's
key and only opens a new segment if it differs from the currently-open
one. Faces before any `o`/`g` statement get the fallback labels
`"Default"`/`["Default"]`. This keeps segment count proportional to actual
*state changes that produced geometry*, not to the number of scene
statements in the file.

### Normals: two full-length arrays, not one

Unlike the STL converter — which recomputes a geometric normal for
*every* triangle and never trusts `vn` — the viewer can use source
normals, but a per-corner decision, not a per-file one: `result.normals`
("smooth") uses a valid, non-zero `vn` where a face corner referenced one,
and falls back to that triangle's own geometric normal for any corner
that didn't (or whose `vn` was zero-length — flagged with a
`zero-length-normal` warning, not silently ignored and not rejected as a
parse error). `result.flatNormals` is always geometric, with no
conditional logic at all, so the flat/smooth shading toggle in the UI is
just swapping which precomputed `BufferAttribute` is bound to
`"normal"` — no runtime recomputation on toggle.
`result.hasValidSourceNormals` is true only if at least one corner in the
whole file actually used a real `vn`; the UI disables the shading select
and explains why when it's false, rather than offering a toggle that does
nothing.

### Lines and points: rendered, not just counted

`/obj-to-stl/` only counts `l`/`p` statements (STL can't represent them).
The viewer resolves them: each `l` statement's reference list expands
into `N-1` consecutive line segments (a genuine polyline, not `N`
disconnected pairs), and each `p` statement's references become
independent points. Both reuse `resolveIndex`/`parseIndexInt` for
positive/negative index resolution, so an out-of-range or zero index is
rejected with the same `OBJ_INDEX_OUT_OF_RANGE`/`OBJ_INDEX_ZERO` a
malformed face gets. A file containing *only* lines and/or points (no
faces at all) — which the converter rejects with
`OBJ_UNSUPPORTED_GEOMETRY` — renders successfully in the viewer; only a
file with no triangles, lines *or* points at all is rejected, with the
viewer-specific `OBJ_VIEWER_NO_RENDERABLE_GEOMETRY`.

### Visibility without duplicating geometry

Hiding/showing an object or group never rebuilds or duplicates the
position/normal typed arrays. The Three.js `BufferGeometry` for the
triangle mesh is built once, non-indexed; toggling a segment's visibility
recomputes a small `Uint32Array` index (the concatenation of the visible
segments' own `[triangleStart*3, (triangleStart+triangleCount)*3)`
ranges) and calls `geometry.setIndex()`/`setDrawRange()`. When every
segment is visible (the common case), the index is cleared entirely
(`setIndex(null)`) for the cheapest possible draw path. "Fit visible"
unions the precomputed `.bounds` of only the visible segments (each
segment's bounds are computed once, server-side in the worker, via
`computeBounds()` on that segment's own position sub-range — a
zero-copy `Float32Array.subarray()` view) plus the lines'/points' own
bounds (computed once client-side after load) if those are currently
shown, and repositions the camera's target to that union's center — not
always the origin, unlike "Fit all"/"Reset camera", which always frame
the complete model centered at world origin (since the mesh itself is
translated by `-fullBounds.center`).

### Safety ceilings: hard ceilings for size, truncation for names

Consistent with every existing OBJ limit (`maxVertexCount`,
`maxTriangles`, `maxFaceVertexCount`), new viewer-specific ceilings —
`maxSegments`, `maxLineSegments`, `maxPoints`, `maxMetadataBytes` — throw
a dedicated error (`OBJ_VIEWER_SEGMENT_LIMIT`/`OBJ_VIEWER_LINE_LIMIT`/
`OBJ_VIEWER_POINT_LIMIT`/`OBJ_VIEWER_METADATA_LIMIT`) the instant they'd
be exceeded, rather than silently truncating — this codebase's
established pattern for anything that could otherwise hang the worker or
balloon memory. Individual *names*, though, are truncated in place
(`sanitizeViewerName`, an ellipsis-truncate to `maxNameLength`) rather
than rejecting the whole file over one long object name, and a `g`
statement's simultaneous group-name count is capped
(`maxGroupNamesPerStatement`) the same way — these are display
conveniences with an obvious safe fallback, unlike a triangle/segment
count with no safe partial result.

### Worker pipeline and buffer ownership

`src/workers/obj-viewer.worker.ts` follows the same shape as
`obj-to-stl.worker.ts` (decode → parse → build → transfer), reporting
`reading` → `decoding` → `parsing-faces` → `building-segments` →
`building-viewer-geometry` → `complete`. It transfers `positions`,
`normals`, `flatNormals`, and (when present) `lineGeometry`/
`pointGeometry` back as transferables; segment metadata and warnings are
structured-cloned (small, bounded by the ceilings above). Cancellation is
checked between stages, matching `/obj-to-stl/`'s own precedent — OBJ's
reader side has never threaded the shared `cancellation.ts` primitive
into the single-pass parse loop itself (unlike the *writer* side, e.g.
`serializeOBJ()`/`writeModelXML()`, which does yield mid-loop), and this
phase preserves that existing boundary rather than introducing
inconsistent cancellation granularity between the two OBJ pipelines.

### Verified live in the browser

Beyond the 626-test suite (42 of them new to this phase, covering
parser-primitive reuse, segment boundary/ordering/truncation rules,
positive/negative normal and line/point index resolution, zero-length
normal fallback, mixed-normal-availability files, lines-and-points-only
files, per-segment bounds, and the metadata/segment/line/point safety
ceilings), this phase was verified live in a dev-server browser session:
a hand-built cube (2 objects — one geometric with two material-tagged
groups, one lines/points-only — 8 vertices, 2 normals, 4 faces, 1 line, 1
point) loaded and reported every model-info field correctly (including
`Objects: 1`, since the lines/points-only object contributes no segment —
see "Known limitations" below); wireframe, shading-mode (smooth ↔ flat),
segment-visibility-checkbox, fit-visible, reset-camera, grid and axes
toggles all produced the expected DOM/attribute state changes with no
console errors; an OBJ referencing an out-of-range face index was
rejected with the safe, non-leaking `OBJ_INDEX_OUT_OF_RANGE` message and
left no stale scene; "Open another file" fully reset the UI and disposed
the previous model; the page rendered with no horizontal overflow at a
375px mobile viewport width; and the network log showed only same-origin
dev-server module requests — no request referencing the loaded file's
name, its `mtllib` path, or any other content from inside it, at any
point.

## 3MF Viewer (Phase 4B)

### A second orchestration layer over the reader, not a second parser

`resolveScene()` (the converter's own pipeline) intentionally discards
everything a viewer needs beyond flattened triangle geometry: object and
build-item `name` attributes, per-object and per-triangle color-property
references (`pid`/`pindex`/`p1`/`p2`/`p3`), the actual contents of
`<basematerials>`/`<colorgroup>` resources (only their *presence* is
tracked, as an unsupported-feature name, for the converter's own
"colors-not-preserved" warning), `<metadata>` text, and
production-extension cross-part references. `src/lib/threemf/
viewer-resources.ts` runs its own `XMLHandler` over the same shared
`parseXML()` tokenizer — never a second XML/ZIP reader — to capture all
of it, using the exact same `parseTransform`/`parseThreeMFUnit`/
`threeMFError` primitives `parseThreeMFModel()` uses. `viewer-scene.ts`
then walks the resolved scene using the exact same algorithm
`resolveScene()` uses (cycle detection, depth ceiling, instance ceiling,
inner-then-outer transform composition via `composeTransforms()`,
reflected-winding fix via `transformDeterminantSign()`, once-only unit
conversion via `millimeterFactorFor()` — all imported, none
reimplemented), additionally recording one `ThreeMFViewerSegment` per
mesh-leaf visit and resolving a per-corner color for every triangle.

### `XMLHandler.onText`: one additive primitive, not a second tokenizer

3MF's `<metadata name="Title">My Model</metadata>` stores its value as
element *text content* — something `xml.ts`'s tokenizer had no concept of
at all before this phase, since every OPC/3MF field this codebase
previously read (vertex coordinates, transforms, relationship targets,
...) lives in attributes. Rather than write a second, metadata-only text
extractor, `parseXML()` gained one optional `onText?(text: string): void`
callback on `XMLHandler`, invoked with each entity-decoded text run
between tags. Every existing caller (`model-parser.ts`,
`relationships.ts`) omits it and is completely unaffected — their own
test suites (123 tests) pass unchanged. Only `viewer-resources.ts`'s
handler opts in, tracking a simple "currently inside a `<metadata>`
element" boolean rather than a general text-accumulation stack, since
3MF's `<metadata>` element never nests.

### Segments: one per resolved instance, not a heuristic

Unlike OBJ (which has to detect object/group/material/smoothing-group
*state changes* to invent segment boundaries, since OBJ's structure is
flat), 3MF already has a real hierarchy: Build → build item → component
instance → ... → mesh object. A "segment" is simply one visit to a mesh
leaf during that walk, so `segments.length` always equals
`resolvedInstanceCount` — no boundary-detection heuristic needed, and two
instances of the same underlying mesh object (placed by two build items,
or two components inside one components-object) are always two separate,
independently visible segments, each with its own transform, bounds and
component path.

### Colors: per-corner resolution, hard errors only for malformed values

Per 3MF's property-resolution model: a triangle's effective `pid` is its
own `pid` attribute if present, else the mesh object's default `pid`; the
effective `pindex` per corner is the triangle's own `p1`/`p2`/`p3` (with
`p2`/`p3` defaulting to `p1` when only `p1` is given — the common
"uniform triangle color" case) if the triangle declared a `pid`, else the
object's own default `pindex` uniformly for all three corners.
`viewer-colors.ts`'s `resolvePropertyColor()` looks that `(pid, pindex)`
pair up against the collected `<basematerials>`/`<colorgroup>` resource
maps. Two failure modes are treated very differently, deliberately:

- A **malformed hex value** at definition time (`displaycolor="not-a-color"`)
  is a hard `THREEMF_COLOR_REFERENCE_INVALID` parse error — the same
  "malformed data value at definition time" treatment this codebase's 3MF
  module already gives a non-finite vertex coordinate or an unparseable
  transform.
- A **dangling reference** at resolution time (an unknown `pid`, or a
  `pindex` outside a resolved group's bounds) never fails the file — the
  geometry itself is still perfectly valid, so it's a `color-reference-invalid`
  *warning*, with that specific corner falling back to a neutral color.

Colors are resolved and stored in sRGB (the 3MF core spec's own space)
and converted to linear space once, in `viewer-colors.ts`'s
`srgbChannelToLinear()`, before ever reaching a typed array — a raw
per-corner `Float32Array` handed to a Three.js `BufferAttribute` bypasses
`THREE.Color`'s own colorspace handling entirely, so this conversion has
to happen explicitly or embedded colors would render visibly washed out.
Alpha is parsed and tracked (`hasTransparentColors`, an
`alpha-not-rendered` warning when any resolved color's alpha is below 1)
but never rendered — every surface renders fully opaque, a deliberate
scope decision consistent with 3MF having no analogue to OBJ's
"repair/diagnostics are out of scope" boundary for genuine transparency
compositing.

### Reused, not reinvented: transform composition and reflected winding

`emitTriangle()` in `viewer-scene.ts` resolves each corner's color
*before* the reflection-fix vertex swap `resolveScene()` already performs
for a mirrored transform, then swaps the two affected corner colors
alongside the two affected vertex indices — so `p2`/`p3`'s declared
per-corner colors stay attached to the same rendered corner as their
geometry after the swap, exactly preserving the semantics
`resolveScene()`'s winding fix already established for normals.

### Worker pipeline and buffer ownership

`src/workers/threemf-viewer.worker.ts` mirrors `threemf-to-stl.worker.ts`'s
stage shape (reading-package → validating-package → locating-model →
parsing-model → reading-resources → resolving-components →
building-scene → building-colors → complete) but ends at a
`ThreeMFViewerResult`, never calling `serializeBinarySTL()`. It transfers
`positions`, `normals`, and (when present) `colors` back as transferables;
segments and metadata are structured-cloned, bounded by the same
ceilings enforced during parsing (`maxSegments`, `maxMetadataEntries`,
`maxMaterialGroups`, etc.). Cancellation is checked between stages,
matching `threemf-to-stl.worker.ts`'s own precedent — the 3MF reader's
component-resolution walk has never threaded the shared
`cancellation.ts` primitive into its recursive traversal (unlike the
*writer* side, e.g. `writeModelXML()`, which does yield mid-loop), and
this phase preserves that existing boundary.

### Verified live in the browser

Beyond the 681-test suite (55 of them new to this phase, covering scene
hierarchy — single/multiple mesh objects, single/nested components,
multiple build items, multiple instances of one object, reflected and
identity/translation transform labeling, cycle rejection, depth-ceiling
enforcement, segment-count ceiling, segment range correctness,
cross-part-reference skipping — every declared unit's exact millimeter
conversion, embedded-color resolution from both base materials and color
groups, per-triangle overrides with and without explicit `p2`/`p3`,
distinct per-corner colors, alpha tracking, malformed-hex rejection,
dangling-reference fallback, metadata extraction/truncation/whitespace-
normalization/entity-decoding/entry-limit enforcement, and
texture/beam-lattice/slice-stack/secure-content warning generation
without failing the file), this phase was verified live in a dev-server
browser session with a hand-built package (2 mesh objects, 1 components
object with 2 instances of one mesh via a translated and a reflected
component, 2 base materials, 1 color group, 2 metadata entries): every
model-info field reported correctly (3 resolved instances from 2 build
items, 12 source vertices, 8 rendered triangles, correct millimeter
bounds reflecting the reflected instance's actual placement), the scene
tree correctly listed one row under "Build item 1" and two rows under
"Build item 2", package metadata rendered as plain text, wireframe/
color-mode/grid/axes/segment-visibility/fit-visible toggles all produced
the expected state changes with no console errors, an invalid package
was rejected with a safe error and no stale scene, the page rendered with
no horizontal overflow at 375px, and the network log showed only
same-origin dev-server module requests — no request referencing the
loaded file's name or any metadata/material/path found inside it.

## GLB Viewer (Phase 4C)

### A second, narrower JSON pass — schema.ts already had most of what a viewer needs

`resolveGLBScene()` (the converter's own pipeline) flattens every mesh
into raw triangle positions/normals and discards materials, textures,
images, samplers, vertex colors, UVs, tangents and non-triangle
primitives outright. Unlike 3MF, though, `schema.ts` already parses
node/mesh/scene `name`, morph-target presence and every `TEXCOORD_n`
attribute key — the converter's own geometry path happens to touch those
fields in passing. `viewer-resources.ts` therefore only adds a second,
much narrower `JSON.parse()` pass for the handful of fields `schema.ts`
genuinely never reads: `materials`, `textures`, `images`, `samplers`, and
each accessor's `normalized` flag (needed to decode integer-encoded
`TEXCOORD_0`/`COLOR_0` values correctly). `viewer-primitives.ts` decodes
NORMAL/TANGENT/TEXCOORD_0/COLOR_0 values via `readAccessorRaw()` — the
same bounds/sparse/stride-checked reader the converter's own
`readPositionAccessor()`/`readIndexAccessor()` build on — and expands
`POINTS`/`LINES`/`LINE_LOOP`/`LINE_STRIP` into renderable geometry the
converter's `decodeMeshes()` skips outright (counted only, as
`skippedUnsupportedPrimitiveCount`). `viewer-scene.ts` walks the node
graph with `resolveGLBScene()`'s own exported `selectRootNodeIndices()`/
`localMatrixForNode()`, the same cycle/depth/instance ceilings, and the
same reflected-transform detection via `determinantSign3x3()` — all
reused, none reimplemented.

### Source meters, not the converter's ×1000 millimetre scale

`resolveGLBScene()` multiplies every transformed vertex by
`METERS_TO_MILLIMETERS` because STL output is conventionally millimetre-
scaled for 3D-printing slicers. A viewer has no such convention to honor
— `viewer-scene.ts`'s `transformPoint()` calls never apply that factor,
so `boundsMeters` and every rendered vertex stay in the file's own
source units. The model-info panel shows both meters (the real unit) and
a ×1000 millimetre conversion for reference, but the geometry itself is
never rescaled — this is the one place in this phase where a bug
(`boundsMeters` briefly excluding point-only geometry from the union
during initial development, caught before this phase's own test suite
was complete — see `viewer-scene.test.ts`'s
"includes point/line geometry in the overall bounds" regression test)
would have been easy to introduce by reusing `resolveGLBScene()`'s
`transformAndScale()` helper unchanged; the viewer has its own,
deliberately unscaled `transformPoint()` call instead.

### The correct normal transform: inverse-transpose, not the naive world matrix

A normal vector doesn't transform the same way a position does — under
non-uniform scale or a reflection, the naive world matrix would tilt a
normal away from perpendicular. `computeNormalMatrix()` computes the
inverse-transpose of the world matrix's upper-left 3x3 (linear) part —
reusing the exact same `a,b,c,d,e,f,g,h,i` extraction
`determinantSign3x3()` already uses, so the two functions can never
silently disagree about which matrix elements mean what — and
`applyNormalMatrix()` normalizes the result afterward. This is exercised
directly by `viewer-scene.test.ts`'s non-uniform-scale and
reflected-transform tests, both passing on first implementation. Source
`NORMAL` values are validated (must be `VEC3`/`FLOAT`, every component
finite) before being trusted; when absent or invalid, `viewer-primitives.ts`
computes a *smooth* per-primitive fallback by averaging each vertex's
adjacent face normals — deliberately smoother than OBJ's flat-only
fallback, since GLB's indexed vertex layout makes a per-vertex average
the natural choice, and "flat normals" display mode is still available
separately (see below) without needing a second stored normal array.

### One shared, indexed vertex buffer; `flatShading` toggles the look, not the data

Unlike OBJ/3MF (which store per-corner, non-indexed triangle data),
`viewer-scene.ts` builds one global *indexed* per-vertex buffer
(positions/normals/UV/color), with each segment (node/mesh/primitive
visit) contributing its own contiguous vertex range and its own slice of
the shared `indices` array — exactly matching how a real glTF primitive
is already structured. "Source normals" vs. "Flat normals" display mode
is implemented as a pure `material.flatShading` toggle rather than a
second stored normal array (as OBJ needed): three.js derives per-face
normals from screen-space position derivatives in the fragment shader on
demand, which works correctly on indexed geometry and avoids doubling the
normal buffer's memory for a feature that's purely about how existing
data is shaded.

### Per-primitive PBR materials: `geometry.groups` + a deduplicated material array

3MF deliberately avoided per-segment materials (a single neutral color
was enough for that phase). GLB's requirements — real base-color
factors/textures, metallic-roughness factors, alpha modes — need genuine
per-primitive material assignment, so this phase adopts three.js's
standard technique: one `BufferGeometry` with `geometry.groups` (one
group per visible segment) and `mesh.material` set to an array, one
entry per *distinct* glTF material index actually referenced (deduplicated
via `materialByGltfIndex`, capped by the segment ceiling — never one
material per triangle). Segment visibility and the groups array are
rebuilt *together*, in the same pass (`rebuildTriangleGeometry()`), since
a group's `start`/`count` refer to offsets into the rebuilt index buffer
— rebuilding one without the other would silently misalign materials
with geometry. The other three display modes ("Neutral material",
"Vertex colors", "Color by node") each swap `mesh.material` for a single
shared `Material` instead of an array — three.js renders every group
uniformly with a single material, so groups never need to change when
only the display mode does.

### Embedded images: extracted in the worker, decoded on the main thread

See "Embedded images and main-thread decoding" in the README for the
full reasoning. In short: `viewer-images.ts` (worker-side) only extracts
and validates still-encoded PNG/JPEG bytes via the exact same
`resolveBufferView()` the converter's accessors use; `_client.ts`
decodes them with `createImageBitmap()` on the main thread, with a
feature check and a safe "geometry still renders, texture slot falls
back to neutral" path when decoding is unavailable or fails for one
image. `buildTextureFor()` sets `texture.colorSpace = THREE.SRGBColorSpace`
(base-color textures are sRGB-encoded per the glTF spec) and maps glTF's
`wrapS`/`wrapT`/`magFilter`/`minFilter` sampler enums to their three.js
equivalents via small lookup tables (`mapWrap`/`mapMagFilter`/`mapMinFilter`).

### Verified live in the browser

Beyond the 703-test suite (22 of them new to this phase, covering
indexed/unindexed triangles, nested-node world placement, mesh
instancing as independent segments, node-cycle/depth-ceiling rejection,
segment index-range correctness, the smooth fallback-normal computation,
the non-uniform-scale and reflected-transform normal-matrix math,
base-color-factor/unsupported-texture-map material resolution,
out-of-range material-reference fallback, normalized-integer vertex-color
decoding, points-only and line-strip/line-loop rendering, and the
combined-bounds regression described above), this phase was verified
live in a dev-server browser session with a hand-built file (a UV-mapped,
PNG-textured cube; a second node with a vertex-colored triangle primitive
plus a points primitive — deliberately exercising mesh instancing,
per-primitive materials, embedded-texture decoding, vertex colors and
points in one file): every model-info stat matched hand-computed
expectations (14 source vertices, 13 rendered triangles, 3 points, 1
material/texture/image, "Source normals: Not available" — correctly
reporting the averaged-fallback case), the scene tree correctly grouped
primitives by node, wireframe/color-mode ("Color by node")/grid/axes/
segment-visibility/fit-visible interactions all produced correct state
with no console errors, an invalid (truncated) file was rejected with a
safe error and no stale scene, the page rendered with no horizontal
overflow at 375px, and the network log showed only same-origin
dev-server module requests plus the test harness's own local fixture
fetch — critically, no request for the embedded PNG texture, confirming
it was decoded from bytes already in the file rather than fetched.

## PLY Viewer (Phase 4D)

### The flattest format yet: one shared vertex array, no scene graph at all

Every prior Phase 4 viewer has *some* structure to walk — OBJ's object/
group segmentation, 3MF's build/component tree, GLB's real node graph.
PLY has none of that: a flat list of elements, most commonly just
`vertex` and an optional `face`, with no transforms and no per-instance
concept whatsoever. `viewer-scene.ts` reflects this directly — there is
no `segments` array at all, just one shared `positions` (and optional
`colors`/`normals`/`uvs`) array plus up to two index views into it:
`surfaceIndices` (triangulated face data) and `edgeIndices` (vertex-pairs
from a recognized `edge` element). Every vertex is *always* renderable as
a point regardless of whether it also participates in a face or edge, so
"points" needs no index array of its own — `renderedPointCount` is simply
the full vertex count.

### A viewer-only schema resolver: the converter's face-element requirement doesn't apply

`resolvePLYSchema()` (the converter's own schema resolver, used by
`/ply-to-stl/`) correctly throws `PLY_FACE_ELEMENT_MISSING` when a file
has no `face` element, since STL cannot represent a point cloud.
`viewer-resources.ts`'s own `resolvePLYViewerSchema()` reuses every one
of that resolver's building blocks (`findVertexElement()`,
`findVertexCoordinates()`, `classifyVertexProperties()`,
`findFaceElement()`, `findFaceIndexProperty()`,
`countUnknownFaceProperties()`, `parsePLYHeader()`) completely unchanged,
but makes the face element optional — a point-cloud-only file is a valid,
complete viewer input. It additionally resolves vertex color/normal/UV
property *indices* (`findVertexAttributeIndices()` — `classifyVertexProperties()`
only reports presence, not position) and a conventional `edge` element
(`findEdgeElement()`/`findEdgeIndexProperties()`), recognizing only the
scalar-integer `vertex1`/`vertex2` layout; any other edge property naming
is left unresolved and reported as an unrecognized-layout warning rather
than guessed at.

### Per-vertex, not per-primitive, normal fallback

GLB's smooth-normal fallback operates per *primitive* — a primitive
either trusts its own `NORMAL` accessor wholesale or falls back to an
averaged normal wholesale, since a glTF primitive is the natural unit of
"this batch of vertices shares one normal policy." PLY has no primitives
at all, so `computeSmoothNormals()` makes the decision per *vertex*
instead: each vertex independently uses its own normal if it's present,
finite and non-zero-length, and only that vertex falls back to an
averaged geometric normal (accumulated from every adjacent triangle
across the whole mesh — there's no primitive boundary to accumulate
within) otherwise. This is finer-grained than GLB's own policy, and
correctly so, given PLY's single shared vertex array has no equivalent
boundary to respect.

### Color normalization is strict about the declared scalar type, not the observed range

A `red`/`green`/`blue`/`alpha` (or `r`/`g`/`b`/`a`) property's declared
PLY scalar type determines how its raw value becomes a linear 0..1
channel — `uint8`/`int8` divides by 255, `uint16`/`int16` divides by
65535, `float32`/`float64` is used as-is. A value that's still out of
`[0, 1]` after that conversion (or non-finite) is clamped and flagged
with a warning, and a color property declared with any other scalar type
entirely is treated as invalid outright — this project's now-consistent
"detect precisely, or implement completely, never guess" policy applied
to a new domain.

### Fit-visible needs only bounds subsets, not a combined-bounds union

Because surface/edges/points all draw from the *same* untransformed
`positions` array, `boundsModelUnits` (the full set) is trivial —
unlike GLB, where independently transformed segments made a
combined-bounds union a real, previously-buggy computation (see "Source
meters, not the converter's ×1000 millimetre scale" above). What PLY
still needs is the opposite operation: a *subset* bounds for "fit
visible" when one or two categories are hidden — `boundsFromIndices()`
iterates just a given index array (`surfaceIndices` or `edgeIndices`) to
produce `boundsSurface`/`boundsEdges`, while `boundsPoints` is simply
`boundsModelUnits` again, since every vertex is always a point. A
dedicated regression test proves this subset behavior directly: a
points-only vertex extends `boundsModelUnits` while being excluded from
`boundsSurface`, and an edge-only vertex extends `boundsEdges` while
being excluded from `boundsSurface` — the same category-exclusion bug
class GLB's pre-fix `boundsMeters` once had, guarded against here from
the start.

### Shared `BufferAttribute`s across up to three `BufferGeometry`s

`_client.ts` builds up to three independent Three.js objects — a `Mesh`
for the surface, `LineSegments` for explicit edges, `Points` for the
point category — but only ever constructs one `THREE.BufferAttribute`
each for position/color/normal, attaching the *same* attribute instance
to every geometry that needs it, never duplicating the underlying
`Float32Array` per category. Visibility per category is a plain
`object3D.visible` toggle, not an index rebuild — unlike GLB/OBJ, PLY has
no sub-category granularity within "surface" or "points" to toggle, so
there's nothing to rebuild. Sharing a `BufferAttribute` across multiple
geometries is safe here specifically because `disposeCurrentModel()`
always disposes every one of a loaded model's geometries together, as
one atomic group — never one at a time while a sibling geometry
referencing the same attribute is still being rendered, which is the
scenario where Three.js's per-geometry GPU-buffer release would
otherwise pull a buffer out from under a still-live geometry.

### A genuine bug found during browser verification: `.control-field[hidden]` did nothing

`PLYDisplayControls.astro` hides whole controls (the shading select, the
color-mode select, the point-size slider) via the standard `hidden`
attribute when the loaded file has no surface or no vertex colors —
exactly the "start hidden, reveal when applicable" pattern every prior
viewer's controls panel already uses. Live browser testing caught a real
bug: `tool.css`'s existing `.control-field { display: grid; ... }` rule
unconditionally set `display`, and since author stylesheets always
override the browser's built-in `[hidden] { display: none }` rule
regardless of selector specificity, setting `.hidden = true` on a
`.control-field` had *no visible effect* — the field stayed on screen.
This had never surfaced in OBJ/3MF/GLB because none of those phases ever
hid a whole `.control-field`; they only disabled a `<select>`'s option or
showed an explanatory note beside an always-visible field. Fixed with one
additive rule, `.control-field[hidden] { display: none; }`, verified
live afterward (`getComputedStyle(...).display === "none"`) before this
phase was marked `"ready"`.

### Verified live in the browser

Beyond the 731-test suite (28 of them new to this phase, covering all
three encodings, element/property order tolerance, triangulation,
point-cloud-only success, zero-vertex rejection, out-of-range face/edge
index rejection, the edge-count ceiling, the combined-bounds-subset
regression described above, independent per-category rendering, source/
missing/invalid-normal per-vertex fallback, every color scalar-type
normalization path, out-of-range color clamping, UV pair resolution and
rejection, alpha availability, and comment/`obj_info`/unknown-element/
property counting), this phase was verified live in a dev-server browser
session with six hand-built fixtures: an ASCII quad with full vertex
colors, normals and alpha (every model-info stat matched hand-computed
expectations exactly — 4 vertices, 2 rendered triangles, 10 vertex
properties, 1 comment line, 1 `obj_info` line, "Source normals: Present
and used", 1×1×0 model-unit bounds); a 6-point colored point cloud (0
faces/triangles, "Source normals: Not applicable", shading/wireframe
controls correctly absent from the DOM entirely, not just disabled); a
mixed surface+edge+point fixture exercising the combined-bounds subset
live (unchecking edges/points and clicking "Fit visible" correctly
reframed the camera on just the small surface triangle, excluding a
distant edge and an isolated point from the fit); binary little-endian
and big-endian tetrahedra (both decoded correctly, encoding label
matched); a file with an unrecognized edge-property layout (correctly
skipped, counted as an unknown element, surfaced as a specific warning);
and a structurally invalid file (out-of-range face index) that produced
a safe, specific error message with full recovery — loading a valid file
immediately afterward cleared the error and rendered correctly, with no
stale state. The page rendered with no horizontal overflow at 375px
width, and the network log showed only same-origin dev-server module
requests plus the test harness's own local fixture fetches — no external
request of any kind for a file, an image, or any value found inside one.

## FBX Viewer (Phase 4E)

### No existing parser to extend — a from-scratch binary FBX 7.x reader

Every prior Phase 4 viewer was a second orchestration layer over an
existing Phase 3 converter's reader. FBX has no Phase 3 converter at
all — there is no `fbx-to-stl` in MeshKit — so this phase starts from
zero parsing infrastructure. `src/lib/fbx/` is laid out in the same
layered style every other format uses (types/errors, a bounds-checked
binary cursor, a node-tree parser, a property decoder, document
interpretation, connection resolution, transforms, geometry, layer
elements, materials, images, and a `resolve-scene.ts` orchestrator), but
every one of those layers is new code, not an additive pass over
something that already existed.

### Binary container: iterative parsing, not recursive, with an exact null-record convention

A binary FBX file is a 27-byte header (23-byte magic + 4-byte version)
followed by a tree of node records, each governed entirely by its own
declared `EndOffset` — `binary-parser.ts` reads a node's name and
property list, then compares the cursor position to that `EndOffset`
exactly: equal means a leaf node with no children section at all (no
null record to consume); less means a children section follows,
terminated by a null record (every header field zero) that must land
the cursor exactly on `EndOffset`. Getting this "leaf vs. has-children"
distinction from `EndOffset` comparison, rather than assuming every
node has a null-terminated children section, is what makes the parser's
per-record behavior correct instead of silently over-reading. The parser
itself is a deliberately *iterative* work-stack walk, not JS recursion —
per this phase's own explicit requirement not to recurse through an
unbounded tree — so a maliciously or accidentally deep node tree fails
via `maxTreeDepth` (a controlled `FBX_NODE_DEPTH_EXCEEDED`), never a
native call-stack overflow.

### Version-gated 32-bit/64-bit record fields, with safe 64-bit conversion

Versions below 7500 declare `EndOffset`/`NumProperties`/`PropertyListLen`
as 4-byte fields; 7500 and above use 8-byte fields — a framing detail
`binary-parser.ts` resolves once (`recordHeaderSizes(uses64BitRecords)`)
and threads through every record read, never re-detected per node. The
64-bit case reads through `BinaryCursor.readSafeUint64LE()`, which reads
a `bigint` via `DataView.getBigUint64` and rejects (`FBX_UNSAFE_INTEGER`)
any value exceeding `Number.MAX_SAFE_INTEGER` *before* ever converting it
to a `number` — the array-header fields (`ArrayLength`/`Encoding`/
`CompressedLength`) are unaffected by this version switch and stay
32-bit at every FBX version, a distinction `property-decoder.ts` bakes in
directly rather than re-deriving per property. Object IDs (`FBXObjectId`,
property type `L`) are kept as `bigint` end-to-end, all the way through
`document.ts`/`connections.ts`'s `Map<bigint, ...>` lookups — they're
opaque identifiers needing exact equality, not arithmetic, so `bigint`
avoids float-precision loss entirely rather than trading it for
Map-key convenience.

### Typed-array properties: zlib via `fflate`, size-validated before allocation

Binary FBX's five array property types (`f d l i b`) share one array
header (`ArrayLength`, `Encoding` — 0 raw or 1 zlib, `CompressedLength`)
followed by that many payload bytes. `property-decoder.ts` checks
`ArrayLength * elementSize` against `maxDecompressedArrayBytes` and
`CompressedLength` against `maxCompressedArrayBytes` *before* touching
the payload, then for the compressed case calls `fflate`'s `unzlibSync`
with a pre-sized `{ out: new Uint8Array(declaredBytes) }` output buffer
and verifies the actual inflated length matches exactly afterward — the
identical "validate the declared size, pre-allocate exactly that much,
verify what actually came out" discipline `threemf/package.ts` already
established for ZIP-entry `inflateSync` calls, applied to zlib (not raw
deflate) since that's FBX's own on-disk array-compression convention.

### Connections: an ID graph resolved independent of declaration order, with genuine cycle detection

`document.ts` extracts every `Objects` child into an `{id, fbxClass,
subclass, name, node}` record (rejecting a duplicate `id` outright —
genuinely ambiguous, unlike a dangling reference) and every `Connections`
child into a typed `{kind: "OO"|"OP", childId, parentId,
propertyName?}` tuple (silently skipping a malformed individual tuple —
common/benign, not worth failing the whole file over). `connections.ts`
builds `childrenOf`/`parentsOf` adjacency maps from those tuples in a
single pass, with no assumption that `Objects` precedes `Connections` in
the file (`resolveModelHierarchy`'s own tests build fixtures with
`Connections` declared *first* specifically to prove this). The Model
parent/child tree walk (`resolveModelHierarchy`) tracks a `visited` set
across the whole walk; a genuine implementation bug surfaced by its own
test suite during development — a cycle with **no path to any root**
(e.g. two Models parented to each other, neither connected to id `0`)
never entered the recursive ancestry check at all, since the walk only
starts from resolved roots — was fixed by checking, after the root walk
completes, whether every Model was reached; any that weren't must be
part of a cycle disconnected from every root, since a `structuralParentOf`
lookup only ever returns `null`, the root sentinel, or another *existing*
Model (dangling parents are filtered out during graph-building), so
non-root-reachability can only mean a cycle.

### Transforms: the full FBX SDK formula, in a dedicated, heavily tested module

`transforms.ts` implements the FBX SDK's own documented node-transform
composition —
`T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹` —
with `Rpre`/`Rpost` always evaluated in XYZ order regardless of the
node's own declared `RotationOrder` (which only governs the main `R`
term), and `Rpost` applied as its **inverse** (a rotation matrix's
transpose) — a well-known FBX-importer gotcha this module's own test
suite specifically locks in (`composeLocalMatrix — post-rotation is
inverted`), alongside dedicated tests for degrees-not-radians conversion,
each of the six supported Euler rotation orders producing genuinely
different, hand-derived results, pivot/offset composition, and — the
module's own most safety-critical property — that `composeGeometricMatrix`'s
output is entirely independent of a node's local-transform fields and
vice versa, proving the geometric transform structurally cannot leak
into the matrix propagated to children. `SphericXYZ` (rotation order 6,
a rare gimbal representation) and non-default `InheritType` values (1
`RSrs`, 2 `Rrs`) are detected and warned about, falling back to the
standard XYZ order / `RrSs` composition respectively, rather than
silently mis-composing — this phase implements the overwhelming-majority
default case fully and correctly, and is honest about the two documented
approximations rather than claiming complete inheritance-mode support.

### Geometry: FBX's own polygon-vertex stream, triangulated with the shared, proven triangulator

`geometry.ts` decodes `Vertices` (flat control points) and
`PolygonVertexIndex` (FBX's negative-terminated polygon stream —
`-index - 1` recovers a polygon's final corner) into per-polygon corner
lists, then triangulates each one through the *exact same*
`triangulatePolygon()` `src/lib/mesh/triangulate.ts` already provides to
OBJ and PLY — no fourth ear-clipping implementation. A structurally
malformed stream (too few polygon vertices, an out-of-range control-point
reference, a stream that doesn't end on a terminator) is a hard,
file-level error, matching OBJ/PLY's own precedent; a polygon
`triangulatePolygon()` itself rejects as degenerate, non-planar or
self-intersecting is skipped and counted instead — the same
skip-and-count precedent `resolveGLBScene()` established for post-transform
degenerate *triangles*, applied here to pre-triangulation *polygons*,
and explicitly why the model-info panel has its own "skipped polygons"
field.

### Layer elements: one resolver, four consumers

FBX names a value's granularity (mapping mode: per control point — with
`ByVertice` accepted as a documented legacy spelling — per polygon
corner, per polygon, or one value for the whole mesh) completely
independently of how it's stored (reference mode: inline, or via a
separate index array). `layer-elements.ts` is the single place these two
independent axes combine into "which direct-array slot does this corner
actually use," used identically for normals, UVs, vertex colors and
per-polygon material indices — not four near-duplicate ad hoc readers.
An unrecognized mode combination or an out-of-range index never throws:
it resolves to `null` for that one corner (the caller falls back — a
computed geometric normal, an absent color/UV, material index 0) and
reports which failure class it was, so `resolve-scene.ts` can emit one
bounded, deduplicated, file-level warning rather than one per bad corner.

### Materials, embedded textures, and units/axes normalized exactly once, globally

`materials.ts` reads a practical Lambert/Phong subset (`DiffuseColor`,
`DiffuseFactor`, and `Opacity`/derived-from-`TransparencyFactor` where
available) directly off each Material's `Properties70` block.
`images.ts` extracts a `Video` object's own embedded `Content` bytes
(an `R` raw-binary property) and sniffs PNG/JPEG from the bytes' own
magic number — FBX has no declared MIME type for embedded media the way
glTF does — leaving actual pixel decoding to `_client.ts`'s main-thread
`createImageBitmap()` call, the identical worker-extracts/main-thread-decodes
split the GLB Viewer established. `resolve-scene.ts` builds one
combined normalization matrix — a signed-permutation axis remap (from
`GlobalSettings`' `UpAxis`/`FrontAxis`/`CoordAxis` and their signs) times
a uniform unit-scale factor (`UnitScaleFactor / 100`, since FBX's own
convention is centimeters-per-unit) — and applies it to every vertex
position and (via its own inverse-transpose) every normal exactly once,
globally, after each Model's own local+geometric transform has already
been applied in FBX's native space. When either the axis system or unit
scale is missing or self-contradictory (two axes claiming the same
slot, a sign that isn't `±1`, a non-positive scale factor), this phase
doesn't guess: the corresponding remap/scale stays identity, coordinates
are preserved exactly as declared, and a specific warning explains why —
never a silently wrong meter conversion.

### Vertex layout: per-corner, non-indexed, closer to OBJ's convention than GLB's

Unlike GLB/PLY's indexed layout, `resolve-scene.ts` emits per-corner,
non-indexed position/normal/UV/color buffers — the natural fit, since
FBX layer elements are themselves fundamentally per-corner/per-polygon
data, not per-control-point in the general case. A same-order identity
`indices` array ships alongside purely so `_client.ts` can re-slice it
per visible segment (the same index-buffer visibility technique OBJ and
GLB's viewers already use) without ever duplicating the underlying
attribute buffers.

## Known limitations (Phase 4E)

- Binary FBX only, versions 7000–7700. ASCII FBX is detected via a
  printable-byte heuristic on the file's opening bytes and rejected with
  its own specific `FBX_ASCII_DETECTED` error, distinct from a generic
  "not a valid FBX file" — never silently misread as binary data. A
  version outside the supported range is rejected outright, not
  best-effort parsed.
- This is a **static-mesh viewer**. Animation stacks/curves, skin
  deformers, skeletons, blend shapes, cameras, lights, NURBS/patch
  geometry, subdivision surfaces, constraints and layered textures are
  detected and summarized in `unsupportedFeatures`, but never applied —
  only the file's default, undeformed base geometry ever renders.
- Only Lambert/Phong diffuse color, diffuse factor and (where
  deterministically available) opacity render. Specular/emissive/normal-map/
  physically-based material properties are not read at all — a material
  using them still renders with a sensible diffuse-only appearance,
  never a crash or a missing surface.
- Only PNG/JPEG embedded texture bytes (sniffed from the bytes' own
  magic number) are decoded, connected via `Material → Texture → Video`.
  An externally-referenced texture (no embedded `Content`, or an
  unrecognized embedded format) is detected and disclosed with a
  warning; its path is never fetched, and the affected surface falls
  back to its material's diffuse color.
- `InheritType` values other than the default `0` (`RrSs`) — `1`
  (`RSrs`) and `2` (`Rrs`) — are detected and warned about, then
  approximated as `RrSs` rather than fully, correctly composed; this is
  a genuinely harder scale-inheritance case most lightweight FBX readers
  don't implement either, and this phase is honest about the
  approximation instead of claiming full support.
- `SphericXYZ` (rotation order 6) is detected and warned about, then
  approximated as standard XYZ order — a rare, largely legacy gimbal
  rotation representation out of this phase's scope.
- `LayerElementMaterial` is read and its mapping/reference modes
  (`AllSame`/`ByPolygon`, `Direct`/`IndexToDirect`) are fully resolved
  per polygon, but the *result* one Model/Geometry visit's render segment
  actually uses is its first triangle's resolved material — every
  triangle in that segment renders with that one material, even if a
  geometry's own `LayerElementMaterial` genuinely varies polygon-by-polygon.
  A file whose meshes use one material per geometry (the common case)
  renders correctly; a single geometry deliberately split across several
  materials by polygon does not yet get its own per-polygon
  `geometry.groups` sub-assignment the way GLB's per-primitive materials
  do. `resolveMaterialIndex()`'s own per-polygon resolution is exercised
  and correct at the unit level (`layer-elements.test.ts`); wiring that
  per-triangle result into `_client.ts`'s existing `geometry.groups`
  mechanism (already sub-segment-capable) is the natural next increment,
  not a rewrite.
- Body-reading cancellation is stage-boundary-only (validating header /
  reading node records / resolving objects / resolving connections /
  building geometry / preparing scene), matching every prior reader-side
  viewer in this project — the node-tree walk and the per-Model scene
  walk themselves can't be interrupted mid-traversal, only between the
  worker's own named stages.
- A genuine bug found and fixed during this phase's own test-writing (not
  browser verification): `resolveModelHierarchy`'s cycle detection didn't
  fire for a cycle with no path to any root (two Models parented to each
  other, neither reaching id `0`), since the recursive ancestry check is
  only entered starting from a resolved root. Fixed by checking, after
  the root walk completes, whether every Model was actually visited — an
  unreached Model can only mean it's part of a root-disconnected cycle,
  since every other way to become unreachable (a dangling parent) is
  already filtered out earlier, during connection-graph construction.
  Caught by the dedicated `rejects a hierarchy cycle` test before this
  phase's implementation was considered complete.

## Phase 4E completion summary

The FBX Viewer (`/fbx-viewer/`) is now `"ready"` in the tool registry —
the fifth of six planned Phase 4 viewers, and the first with no existing
MeshKit parser or converter to build on. `src/lib/fbx/` is a complete,
independently-tested binary FBX 7.x reader (see "FBX Viewer (Phase 4E)"
above for its full layer-by-layer design), covering: exact binary
container validation with explicit ASCII rejection; the 32-bit/64-bit
node-record switch at version 7500 with safe 64-bit-to-`number`
conversion; all 13 property type codes including zlib-compressed typed
arrays; an order-independent, cycle-rejecting Model hierarchy; the FBX
SDK's full documented transform formula (post-rotation inversion,
geometric-transform isolation, all six Euler rotation orders, pivots and
offsets); polygon triangulation reusing the shared, proven
`triangulatePolygon()`; a single mapping-mode/reference-mode layer-element
resolver shared by normals/UVs/colors/materials; Lambert/Phong materials
with embedded PNG/JPEG textures decoded the same main-thread
`createImageBitmap()` way the GLB Viewer's are; and axis/unit
normalization applied exactly once, globally, with an honest "preserve
raw coordinates and warn" fallback when the file's own metadata is
incomplete or contradictory. New, additive infrastructure this phase
leaves for later work: the iterative (non-recursive) node-tree-walk
pattern for any future binary tree format, the safe-64-bit-conversion
convention (`readSafeUint64LE`), the shared layer-element resolver shape
for any future per-corner/per-polygon attribute scheme, and the
signed-permutation axis-remap-matrix technique for any future format
with its own declared coordinate convention.

## Universal 3D File Viewer (Phase 4F)

### An integration/routing layer, not a sixth parser

`/viewer/` adds no new geometry-reading code at all. Every byte of actual
parsing still happens inside the five existing dedicated-viewer workers
(`stl-viewer.worker.ts`, `obj-viewer.worker.ts`, `threemf-viewer.worker.ts`,
`glb-viewer.worker.ts`, `ply-viewer.worker.ts`, `fbx-viewer.worker.ts`) —
`src/lib/viewer/` is purely detection, dispatch and presentation-shape
code layered on top of those six already-tested pipelines. Six thin
adapters (`src/lib/viewer/adapters/*-adapter.ts`) each wrap exactly one
worker unchanged and import that worker's own real result type
(`STLParseResult`, `OBJViewerResult`, `ThreeMFViewerResult`,
`GLBViewerResult`, `PLYViewerResult`, `FBXViewerResult`) rather than a
hand-duplicated local approximation, so an adapter is type-checked
against the exact shape its dedicated viewer page already produces —
if that shape ever changes, the adapter fails to compile instead of
silently drifting.

Each adapter owns its own module-scoped Three.js scene state (a mesh, a
geometry, a material list, decoded textures — the same top-level `let`
variables every dedicated page's own `_client.ts` already uses), so no
explicit "handle" object needs to be threaded through the shared shell —
the adapter module *is* its own handle. The shared viewport (canvas,
renderer, camera, lights, resize observer, `OrbitControls`) is owned
once by `src/pages/viewer/_client.ts` itself and never rebuilt per
format; only an adapter's own geometry/material content is added to and
removed from that one shared `THREE.Scene`. This keeps `_client.ts`
itself a genuine dispatcher (detect → load an adapter → run its worker →
call its own `buildScene`/`applyDisplayOptions`/`disposeScene`) rather
than six large format-specific branches copied into one file.

### Content-based detection, reusing each format's own production validator

`format-detection.ts`'s `detectFormat()` never guesses from a file's
extension — the declared extension is only ever compared against the
*detected* format afterward, to drive the UI's own mismatch note. Every
check reuses an existing, already-tested piece of a production parser
rather than a second, possibly-diverging sniff, and is tried in this
fixed order, each on a small bounded prefix (`TEXT_PREFIX_BYTES = 8192`
for every text-based heuristic) or — for 3MF — only the ZIP central
directory plus the tiny `_rels/.rels` entry, never a full parse:

1. **GLB** — the 12-byte header's `glTF` magic, version `2`, and a
   declared total length of at least 12 bytes.
2. **Binary FBX** — the exact `Kaydara FBX Binary` magic string
   `fbx-viewer.worker.ts`'s own reader expects.
3. **A ZIP local-file or empty-archive signature** — if present, this
   *must* resolve to 3MF or the file is rejected outright, never
   fall through to try another format. `detectThreeMF()` calls
   `threemf/package.ts`'s real `openThreeMFPackage()` (the same bounded
   ZIP central-directory reader `3mf-viewer` itself uses) and
   `threemf/relationships.ts`'s real `findPrimaryModelPath()` (genuine
   OPC relationship resolution), inside a try/catch that treats any
   failure as "not 3MF" — never a second, independent "does this look
   like a 3MF" heuristic. A generic ZIP or a ZIP missing a resolvable
   model relationship is reported as "a ZIP archive, but not a valid 3MF
   package," not a silent fall-through to OBJ/STL text-sniffing.
4. **Binary STL** — `stl/detect.ts`'s exact
   `84 + triangleCount × 50 === byteLength` formula, the identical check
   `stl-viewer` itself uses to distinguish binary from ASCII STL.
5. **PLY** — a first line of exactly `ply` decoded with the *same raw
   per-byte `charCode` mapping* `ply/header.ts`'s own `decodeAsciiSpan`
   uses, deliberately not a real UTF-8 `TextDecoder`. This distinction is
   load-bearing: a genuine UTF-8 decode turns a leading BOM into (or
   toward) U+FEFF, which is itself part of JS's `trim()` whitespace
   class, so a real-UTF-8 detector would accept a BOM'd file the
   production PLY parser's own raw-byte `lines[0].trim() !== "ply"`
   check actually rejects. Mirroring the raw-byte decode keeps the
   detector's verdict consistent with what dispatching to the real PLY
   pipeline will actually do. A recognized magic line with no supported
   `format` declaration in the sampled prefix is reported with
   `"tentative"` confidence rather than `"certain"`, but still dispatched
   to PLY — the real parser gives the precise, authoritative error.
6. **ASCII STL** — `stl/detect.ts`'s own `looksLikeAsciiSTL()` (exported
   for this reuse), the same "a `solid` declaration with real `facet
   normal` records" structural check `stl-viewer` uses.
7. **ASCII FBX** — a distinctive `FBXHeaderExtension` marker in the
   bounded text prefix (deliberately not just "starts with a `;`
   comment," which plenty of non-FBX text could also do). Detected as
   format `fbx` at `"strong"` confidence — dispatch still proceeds to the
   FBX adapter/worker, which is what actually produces the specific,
   user-facing "binary FBX only" rejection (see "Universal error
   vocabulary" below), rather than the detector inventing that message
   itself.
8. **OBJ** — a coherence heuristic, not a single-keyword guess:
   `OBJ_MIN_MATCHING_LINES = 2` recognized record keywords (`v vn vt f l
   p o g usemtl mtllib s`) must appear among the prefix's non-blank,
   non-comment lines, at least one of which must be `v` or `f`, before
   text is classified as OBJ. A line that isn't blank, a comment, or a
   recognized record at all stops the scan and rejects the file — real
   OBJ text won't have many of those near the top of the file.
9. Anything else — `format: null`, `confidence: "none"`, and a fixed,
   safe "couldn't be confidently identified" message. `format` is
   genuinely nullable in `DetectionResult` specifically so this state is
   representable without a sentinel value threaded through the rest of
   the pipeline.

### Adapter registry: lazy-loaded, exhaustive at compile time

`adapter-registry.ts`'s `ADAPTER_LOADERS` is a
`Record<DetectedFormat, () => Promise<ViewerAdapterModule>>` where every
entry is a genuine dynamic `import()` — TypeScript's exhaustiveness
checking on the `Record` guarantees all six (and only six) formats have
an entry, and Vite code-splits each adapter (plus, transitively, the
worker it constructs) into its own chunk. A production build confirms
this: `stl-adapter` (~1.5 kB), `threemf-adapter` (~3.7 kB), `obj-adapter`
(~4.3 kB), `ply-adapter` (~4.5 kB), `fbx-adapter` (~5.1 kB) and
`glb-adapter` (~6.5 kB) are all separate, independently-fetched chunks,
none bundled into `/viewer/`'s own initial page load and none bundled
into each other — selecting one file only ever fetches that one format's
adapter and worker files, confirmed against dev-server network requests
(only the detected format's `*-adapter.ts` and `*.worker.ts` load) and
against the production build's per-chunk output. The homepage bundle
carries zero references to any viewer/adapter code at all — `/viewer/`
is exclusively reachable through its own page's own script.

### Resource ownership: a `generation` counter, plus a real bug this phase found and fixed

`_client.ts` guards every async boundary a file selection crosses (file
read → detection → adapter dynamic import → worker round-trip) with a
`generation` counter, incremented on every new file selection and file
clear — the same pattern `WorkerClient` itself already uses for stale
`requestId` protection, just one layer higher, since detection and
adapter-loading happen *before* any worker request exists to have a
`requestId` at all. A response whose captured generation no longer
matches the current one is silently dropped: the previous model is
disposed immediately (before any of the new file's async work even
starts), object URLs are revoked, and a stale late-arriving result never
overwrites newer state or reappears after a reset.

The one WorkerClient instance is deliberately reused across selections
whenever the detected format doesn't change (`ensureWorkerForFormat`'s
own fast path), rather than tearing down and recreating a worker for
every file — the same "one persistent worker for the page's lifetime"
shape every dedicated viewer page already uses. This reuse path exposed
a genuine bug during this phase's own browser verification (not caught
by the unit/integration test suite, which never exercises the real
`Worker` this bug lived in): the WorkerClient's `onProgress`/`onResult`/
`onError`/`onCancelled` callbacks are only ever registered once, at the
moment a worker is actually created, and originally closed over that
one call's `myGeneration` value directly. Every *subsequent*
same-format file selection bumps the shared `generation` counter but,
on the reuse fast path, never re-registers those callbacks — so the
closures' captured `myGeneration` became permanently stale after the
very first load, and `if (myGeneration !== generation) return;` silently
discarded every later response forever. The symptom was exact and
reproducible: any second file of a format already used in the same page
session hung at "Processing" indefinitely, with no console error (the
guard is intentional code, not a thrown exception) — including the
ordinary "fix a mistake and reselect the same format" recovery flow.
The fix replaces the closures' captured `myGeneration` with a shared,
live-read `requestGeneration` variable that `processSelectedFile` updates
immediately before each actual `workerClient.process(...)` call, so the
*same* long-lived callbacks correctly compare against whichever
generation is currently active, regardless of how many times the
underlying worker has been reused. `WorkerClient`'s own `requestId`
matching (unaffected by this bug) continues to be the guard against
genuine cross-request mixups; `requestGeneration` solves the separate
"is this file selection still the one the user cares about" concern.
Verified after the fix: three consecutive same-format loads for every
one of the six formats, the full STL→GLB→PLY→FBX→OBJ→3MF replacement
chain, and the original error-then-recovery repro (an invalid FBX file
followed by a valid one) all complete correctly with no hang.

### Universal error vocabulary: reused, never replaced

`_client.ts` adds exactly five new error codes of its own
(`VIEWER_FORMAT_UNKNOWN`, `VIEWER_FORMAT_AMBIGUOUS`,
`VIEWER_DETECTION_LIMIT_EXCEEDED`, `VIEWER_ADAPTER_UNAVAILABLE`,
`VIEWER_ADAPTER_LOAD_FAILED`) — all for orchestration concerns that
exist only at this integration layer (detection failed before any
format-specific code ever ran; an adapter's dynamic `import()` itself
failed). Once a file is dispatched to a specific format, every error
that pipeline's own worker produces is reused verbatim, unchanged and
uncaught-and-rewrapped — an invalid binary FBX file still surfaces "This
FBX file references a control point that doesn't exist," an ASCII FBX
file still surfaces its own specific "binary FBX only" message, exactly
as browser verification confirmed. The universal shell never catches a
precise, format-specific parser error and downgrades it to a vague
"something went wrong."

### Universal model info: a fixed common set plus one dynamic per-format grid

`UniversalModelInfo.astro` deliberately chooses neither a fully-reduced
common-denominator panel nor six fully-branching format-specific
components: a small fixed field set every format actually shares
(filename, size, detected format, detection confidence, width/height/
depth) renders through one shared markup block, while a second,
genuinely dynamic grid (`data-info-format-specific`) is populated at
runtime from whichever adapter is active — each adapter's own `info()`
returns only the fields honest for its own format (FBX version/encoding/
model-and-geometry counts, GLB's glTF version, 3MF's declared unit,
etc.), never a value borrowed from another format's concept.
`UniversalSceneTree`/`UniversalMaterialPanel` follow the identical
shape, driven by each adapter's own `segments()`/`materials()`.

### Deliberate, disclosed shell-level reductions

A few per-format capabilities are intentionally narrower inside the
universal shell than in that format's own dedicated page — chosen and
documented here rather than left to emerge accidentally:

- The GLB adapter drops the dedicated GLB Viewer's fourth "color by
  node" mode, exposing only `original`/`neutral`/`vertex-colors` —
  `/glb-viewer/` remains the place for that specific inspection mode.
- FBX's `LayerElementMaterial` per-polygon material variation still
  renders as one material per mesh-instance segment (the same
  limitation `/fbx-viewer/` itself already has and discloses — see
  "Known limitations (Phase 4E)").

Every other per-format rendering behavior — GLB's per-primitive
`geometry.groups` multi-material and node color modes, PLY's shared
`BufferAttribute` across Surface/Edges/Points, OBJ's per-object/group
index-rebuild visibility and dual normal/flat-normal shading, 3MF's
original/neutral color modes and declared-unit-plus-mm dimensions, and
FBX's per-material Three.js materials with embedded-texture decode — is
preserved at full fidelity, unreduced from its dedicated page.

## Known limitations (Phase 4F)

- File-type detection is content-based and bounded (a small fixed
  prefix per format, or 3MF's ZIP central directory plus `_rels/.rels`)
  — it is a fast, well-evidenced classification, not a full parse, so a
  deliberately adversarial file could in principle be crafted to satisfy
  one format's structural signature while actually being a different,
  malformed file of that same format. This is the identical trust
  boundary every dedicated viewer's own worker already re-validates
  fully on its own first real parsing pass — detection dispatch is never
  the sole safety gate for anything.
- Ambiguity is resolved by fixed detection order, not by comparing
  confidence across formats: a file could in theory be constructed to
  satisfy an earlier check's *signature* (e.g. a ZIP whose first bytes
  also happen to look like something else) while genuinely being a
  later format — the ordering documented above (GLB → binary FBX → ZIP/
  3MF → binary STL → PLY → ASCII STL → ASCII FBX → OBJ) is deliberate
  (most distinctive/least ambiguous magic first) but is a priority list,
  not proof of mutual exclusivity for every conceivable byte sequence.
- The five dedicated single-format viewer pages (`/stl-viewer/`,
  `/obj-viewer/`, `/3mf-viewer/`, `/glb-viewer/`, `/ply-viewer/`,
  `/fbx-viewer/`) remain their own indexed, linkable routes rather than
  becoming internal implementation details — each still ranks for its
  own format-specific search intent, and each still uses its own
  single-format `validateSelectedFile()` extension gate, which
  `/viewer/` deliberately does not.
- The GLB adapter's dropped fourth color mode and FBX's per-mesh-instance
  (not per-polygon) material resolution are shell-level reductions from
  each format's own dedicated page — see "Deliberate, disclosed
  shell-level reductions" above.
- Cancellation is UI-request-only, not guaranteed instantaneous: it
  posts a `cancel` message tagged with the in-flight request's id, and
  the worker honors it at its own next named-stage boundary — identical
  to every dedicated viewer's own cancel behavior, never a stronger
  guarantee just because this shell reuses six different workers.
- A genuine bug found and fixed during this phase's own browser
  verification (not caught by the unit/integration suite, which never
  exercises a real `Worker`): reusing the same-format `WorkerClient`
  across file selections left its event callbacks bound to the first
  selection's stale `generation` snapshot, silently discarding every
  later same-format response forever. See "Resource ownership" above
  for the full root cause and fix.

## Phase 4F completion summary

`/viewer/` is now `"ready"` in the tool registry — the sixth and final
planned Phase 4 viewer, and the only one that adds no new parsing code
of its own. `src/lib/viewer/` (`format-detection.ts`, `adapter-types.ts`,
`adapter-registry.ts`, `formatting.ts`, and six `adapters/*-adapter.ts`
files) is a complete, independently-tested integration layer over the
five existing dedicated viewer pipelines (STL, OBJ, 3MF, GLB, PLY,
binary FBX) built across Phase 2 through Phase 4E: content-based format
detection reusing each format's own production validator rather than a
second sniffing implementation; an exhaustive, lazily-loaded adapter
registry with Vite code-splitting confirmed at both the dev-server
network level and the production build's per-chunk output; a shared
Three.js viewport with six self-contained adapter modules instead of
six branches copied into one file; a `generation`-counter resource-
ownership discipline (plus the same technique's own real bug, found and
fixed this phase — see "Resource ownership" above); a universal error
vocabulary that reuses every format-specific error unchanged after
dispatch; and a universal model-info panel combining a small fixed
common field set with a genuinely dynamic per-format grid. All 946 unit/
integration tests (31 new detection tests, 8 new registry tests, 27 new
adapter-normalization tests, 7 new end-to-end integration tests
including the full STL→GLB→PLY→FBX→OBJ→3MF replacement chain) plus every
pre-existing dedicated-viewer test continue to pass unchanged, `astro
check` reports 0 errors/0 warnings/0 hints across 289 files, and the
production build emits `/viewer/index.html` with correct canonical/
structured-data output and six independent adapter chunks alongside the
one shared `three.module` chunk. New, additive infrastructure this phase
leaves for later work: the `generation`-counter-for-pre-worker-async-
boundaries pattern (useful for any future page that needs to guard state
across more than one async step before a worker request exists), and the
"reuse the real result type, never a hand-duplicated local one" adapter
convention for any future thin-wrapper integration layer.

## STL Diagnostics (Phase 5)

### An analysis layer over an immutable topology model, never a second STL reader

`/stl-checker/` and `/stl-validator/` add no new file-format parsing —
both dispatch to the exact same `parseSTL()` every other STL-consuming
page already uses, then hand the resulting `positions: Float32Array` to
`src/lib/stl-diagnostics/analyze.ts`. The real new work is a
format-neutral triangle-soup topology layer in `src/lib/mesh/`
(`canonical-vertices.ts`, `edge-incidence.ts`, `connected-components.ts`,
`boundary-components.ts`, `orientation.ts`, `duplicate-faces.ts`,
`triangle-intersections.ts`, `spatial-index.ts`) — deliberately homed
there rather than under `stl-diagnostics/`, since none of it is
STL-specific; any future format's own triangle-soup diagnostics could
reuse it unchanged. `src/lib/stl-diagnostics/` is purely the STL-facing
orchestration on top: `types.ts` (the full report contract), `errors.ts`
(translates the mesh layer's own generic exceptions), `analyze.ts` (the
pipeline), `verdict.ts` (the watertight policy), `formatting.ts`,
`report.ts` (the downloadable JSON shape) and `test-fixtures.ts`.

### Vertex identity: exact float32 matching, reusing the existing deduplicator unchanged

Every topology stage starts from `canonical-vertices.ts`'s
`buildCanonicalMesh()`, which calls `mesh/deduplicate.ts`'s existing
`deduplicateVertices()` — the same bit-exact, `-0`/`+0`-normalized
float32 matching every STL→OBJ/STL→3MF converter's own vertex count
already uses — rather than a second, diagnostics-specific
implementation. This is a deliberate policy choice, not just reuse for
its own sake: welding "close enough" vertices would change which edges
are shared and could hide a real gap between two surfaces that only
looks closed after welding. Degenerate triangles (a repeated vertex, or
zero/near-zero area — the near-zero threshold scaled to the mesh's own
bounding-box diagonal squared, since area scales quadratically with
linear size) are classified in this same pass and excluded from every
downstream stage; `CanonicalMesh.validTriangles` is the only input every
later module ever sees.

### Edge incidence: one shared map, two orthogonal classifications

`edge-incidence.ts` builds a single undirected edge map over
`validTriangles`, classifying each edge by incident-triangle count
(boundary: 1, manifold: 2, non-manifold: 3+) and — orthogonally — by
whether two or more of its directed traversals run the SAME direction (a
winding conflict, kept as its own boolean rather than folded into the
count-based class, since a manifold 2-triangle edge can still be
winding-inconsistent). Every later stage (boundary components, shells,
orientation) reads this one map; none re-derive adjacency their own way.

### Boundary components: closed loop, open chain, branched, or non-simple — never "N holes" from a bare edge count

`boundary-components.ts` groups boundary edges into connected components
(via shared vertices) and classifies each by its own vertex-degree
signature: all-degree-2 and edge count equals vertex count is a
`closed-loop` (graph theory guarantees a connected 2-regular graph is
exactly one cycle); exactly two degree-1 endpoints is an `open-chain`;
any vertex with degree ≥3 is `branched`; anything else is `non-simple`.
A genuinely open (non-closed) boundary path is not realizable as the
boundary of any finite, simply-connected, manifold-consistent embedded
triangle patch — merging two independently-closed loops at one shared
point always produces a degree-4 branch vertex, never two degree-1
endpoints, a basic surface-topology fact this phase's own test fixtures
had to work around (see `test-fixtures.ts`'s own module doc): the
`open-chain` classification path is verified directly against a
synthetic edge graph in `boundary-components.test.ts`, since no real 3D
mesh fixture can exercise it.

### Shells: iterative union-find over shared edges, never JS recursion

`connected-components.ts` resolves triangle shells via iterative,
path-compressed union-find keyed on shared EDGES (not vertices) — a
point-only contact between two triangles never appears in the edge map
at all, so "point-touching shells stay separate" falls directly out of
the definition rather than needing special-case code (verified by its
own dedicated fixture). Iterative, not recursive, so a pathologically
long triangle chain fails safely via this report's own edge-record
ceiling, never a native call-stack overflow.

### Orientation: BFS 2-coloring for BROADCASTABILITY, signed volume only when it's a meaningful question

`orientation.ts` propagates a per-triangle parity via BFS over each
shell's own MANIFOLD edges only (non-manifold edges have no single
well-defined "the other triangle" relation, so they neither confirm nor
break orientability here). This is the standard bipartite-graph
orientability check: a single winding-conflict edge with no surrounding
cycle is still "consistently orientable" (flip one triangle and the
conflict resolves) — only an ODD CYCLE of conflicts makes consistent
orientation genuinely impossible, a distinction this module's own test
suite locks in explicitly (`inconsistentAdjacentWinding()` — one
conflict, still orientable — verified NOT to regress into "any conflict
= inconsistent," which was this module's own first, incorrect, test
expectation, caught before merge). Signed volume (the origin-relative
tetrahedron sum, translation-invariant for a genuinely closed surface —
verified directly with a fixture translated to a `1e5`-magnitude offset)
is computed for every shell, but only trusted for the inward/outward
verdict when the shell is BOTH closed AND consistently orientable AND
its magnitude clears a scale-aware near-zero threshold; otherwise the
verdict is `"indeterminate"` — never a guess.

### Duplicate faces: canonical rotation keys, never a full O(n²) triangle comparison

`duplicate-faces.ts` groups valid triangles by a winding-INDEPENDENT
3-vertex identity key (sorted ascending), then splits each group by a
winding-preserving canonical rotation key (rotate to start from the
smallest vertex ID, keep the original cyclic order) — at most 2 distinct
winding keys per identity group, by construction. Two triangles merely
sharing an EDGE (2 of 3 vertices) always land in different identity
groups, so ordinary adjacency is never mistaken for a duplicate.

### Self-intersections: spatial-grid broad phase, Möller-style narrow phase, disclosed exclusions

`spatial-index.ts` buckets triangle AABBs into a uniform grid sized from
the mesh's own bounding-box diagonal divided by a target cell count
(scale-aware), returning deduplicated candidate pairs bounded by an
explicit ceiling — never an all-pairs O(n²) scan.
`triangle-intersections.ts`'s narrow phase is a Möller-style
separating-plane test with an explicit coplanar fallback (2D edge-
crossing plus an inclusive full-containment check, the latter added
specifically to correctly detect two exactly-coincident triangles, which
neither edge-crossing nor a strict single-point containment test alone
catches — found and fixed via this module's own test suite before
merge). Three categories of pair are excluded from testing/reporting by
policy, not by the narrow-phase test's own geometry: pairs sharing a
topology edge (expected manifold adjacency), pairs already reported as
duplicate faces (the same finding, never double-reported under two
names), and — implicitly, since callers only ever pass
`validTriangles` — any pair involving a degenerate triangle. Pairs
sharing only a VERTEX are deliberately NOT excluded — they're tested
normally, correctly resolving to "no intersection" for simple touching
and "intersects" for genuine crossing that happens to also share a
point. This stage is the one part of the whole pipeline with its own
mid-loop cancellation (`await yieldIfCancelled` inside the candidate-pair
loop) — see "Cancellation and the work budget" below for why it's the
only stage that needs it.

### The watertight verdict: an explicit, disclosed, testable policy

`verdict.ts`'s `computeVerdict()` is deliberately small and pure: zero
valid triangles is `"invalid-topology"`; any DEFINITE failure (boundary
edges, non-manifold edges, winding conflicts, duplicate faces, or — per
the named `STRICT_WATERTIGHT_REQUIRES_NO_SELF_INTERSECTIONS` policy
constant — a completed self-intersection check that found any) is
`"not-watertight"`, reporting every applicable reason at once, not just
the first; a self-intersection check that couldn't complete (a safety
ceiling was hit) with no other definite failure is `"indeterminate"` —
never silently `"watertight"`; otherwise `"watertight"`. Notably, an
INWARD-oriented closed shell is still `"watertight"` under this policy —
orientation and watertightness are independent facts, and conflating
them would misrepresent a topologically sound but likely-inverted model
as broken. The separate `computeSlicerRisk()` never produces a numeric
score — only a bounded list of severity-tagged, plain-language
observations, always shown alongside the fixed disclaimer set
(`SLICER_RISK_DISCLAIMERS`) that passing doesn't guarantee printability
and failing doesn't mean a file can't be sliced.

### Cancellation and the work budget

`analyze.ts` checks cancellation and an overall `maxAnalysisMs` budget at
every one of its 9 named stage boundaries — matching every other
worker's "cancel between named stages" convention — plus TWO stages get
genuine mid-loop cancellation: vertex deduplication (already supported
for free via the existing `deduplicateVertices`) and self-intersection
narrow-phase testing (added this phase). This is a deliberate, disclosed
scope decision: every other stage (edge incidence, boundary components,
shells, orientation, duplicate faces) is already bounded by this
report's own vertex/edge/group ceilings and completes in well under a
frame even for multi-million-triangle meshes in practice; self-
intersection testing is the one stage whose cost isn't already
implicitly bounded by a single O(triangle count) pass. If the budget is
exceeded before the mandatory core topology stages finish,
`STLDiagnosticsBudgetExceededError` fails the analysis outright (there's
no way to produce a meaningful report without them); if only the
self-intersection stage remains, it's skipped and honestly reported
`"not-checked"` rather than run over budget — the same "skip and
disclose, never claim pass" policy every other safety ceiling in this
report follows.

### Worker lifecycle: single persistent worker, structurally immune to the Universal Viewer's own staleness bug

`src/workers/stl-diagnostics.worker.ts` follows `stl-viewer.worker.ts`'s
exact shape (parse → analyze → transfer every overlay buffer + the
original render geometry). `src/pages/stl-checker/_client.ts` — the
SHARED implementation both `/stl-checker/` and `/stl-validator/` import
unchanged — follows `stl-viewer/_client.ts`'s single-persistent-worker
pattern (one `WorkerClient`, its event callbacks bound exactly once at
page boot) rather than the Universal Viewer's per-format worker-reuse
pattern. This isn't an oversight: the Phase 4F staleness bug (see
"Universal 3D File Viewer (Phase 4F)" above) was caused specifically by
reusing a `WorkerClient`'s callbacks across a changing concern (the
detected format) while those callbacks closed over a generation snapshot
that was never re-bound. A single-format page like this one has no such
changing concern — the same callbacks are correct for every file
selection for the page's entire lifetime — so the bug class doesn't
arise structurally, not just by convention. Verified directly in browser
testing anyway: three consecutive same-file selections, and a mixed
sequence of different STL fixtures selected back to back, all completed
correctly with no hang.

## Known limitations (Phase 5)

- Vertex identity is exact float32 coordinate matching only — never
  distance-tolerance welding. Two positions that differ by even one
  float32 ULP are treated as genuinely distinct vertices; near-duplicate
  detection (a documented, scale-aware, non-authoritative candidate list)
  was considered but not implemented this phase, since it isn't needed
  for the strict verdict and welding remains explicitly out of scope
  until Phase 6.
- The self-intersection check's broad phase has an explicit candidate-
  pair ceiling (`maxCandidateIntersectionPairs`, default 2,000,000).
  Browser verification against a 57,120-triangle UV-sphere fixture hit
  this ceiling (after ~5 seconds inside the broad-phase pass) and
  correctly reported `"not-checked"` rather than a false pass — a real,
  disclosed limit of the current spatial-grid tuning, not a bug: dense,
  highly-curved meshes in roughly this size range and above may need
  self-intersection checking skipped even when otherwise well-formed.
  Every other check still completes and is reported normally.
- `analyzeShellOrientation`'s BFS parity propagation correctly handles
  the "single winding conflict, no surrounding cycle, still orientable"
  case (tested directly), but this phase's own test suite does not
  include a hand-built genuinely NON-orientable multi-triangle fixture
  (a minimal Möbius-band-style triangulation) — constructing one
  correctly by hand turned out to require more triangles than a simple 3-
  or 4-triangle ring can express (any such small ring's shared edges
  necessarily meet at one common hub vertex, which is always orientable —
  see the reasoning trail in the Phase 5 completion report). The
  "detects a contradiction" branch of the same well-understood, standard
  2-coloring algorithm is exercised implicitly by every other orientation
  test, but not by a dedicated non-orientable-surface fixture.
- Mid-loop cancellation is implemented for exactly two stages (vertex
  deduplication, self-intersection testing) — see "Cancellation and the
  work budget" above for why the other stages don't need their own.
- `/stl-checker/` and `/stl-validator/` both self-canonicalize (documented
  choice — see each page's own top-of-file comment) rather than one
  canonicalizing to the other, since their copy is genuinely distinct,
  not a mechanical duplicate; both mount the exact same shared
  `_client.ts` and the exact same results/controls components.
- This phase is diagnostics only. It never modifies, repairs, welds,
  reorients or exports a changed mesh — see Phase 6.

## Phase 5 completion summary

`/stl-checker/` (primary) and `/stl-validator/` (secondary SEO route,
same shared implementation) are now `"ready"` in the tool registry.
`src/lib/mesh/` gained a complete, independently-tested, format-neutral
triangle-soup topology layer (exact-identity canonical vertices with
degenerate classification, edge incidence with orthogonal manifold/
winding classification, boundary-component classification, iterative
union-find shell resolution, BFS-parity orientation with translation-
invariant signed volume, canonical-rotation duplicate-face detection, and
spatial-grid-accelerated self-intersection testing) — all eight modules
independently unit-tested against dedicated fixtures before the
orchestration layer was ever written. `src/lib/stl-diagnostics/` is the
STL-facing analysis pipeline on top (9 named, cancellable, budget-checked
stages; a small pure watertight-verdict policy function; a separate,
disclaimer-accompanied slicer-risk summary; a schema-versioned
downloadable JSON report excluding raw geometry/file bytes/header text).
A real narrow-phase self-intersection bug (exact-duplicate triangles not
detected as overlapping, since neither the edge-crossing nor the strict
single-point-containment check fires for fully coincident triangles) was
found and fixed by this phase's own test suite before merge, alongside a
test-authoring mistake of its own (an initial, incorrect assumption that
any single winding-conflict edge makes a shell non-orientable, corrected
once the standard graph-orientability definition was applied correctly).
All 1,048 unit/integration tests (73 new mesh-topology tests across 8
modules, 66 new `stl-diagnostics` tests including a full end-to-end
verdict matrix against every fixture) plus every pre-existing test
continue to pass unchanged, `astro check` reports 0 errors/0 warnings/0
hints across 324 files, and the production build emits both pages plus a
`stl-diagnostics.worker` chunk. New, additive infrastructure this phase
leaves for later work: the entire `src/lib/mesh/` topology layer itself
(explicitly format-neutral — any future triangle-soup format's own
diagnostics could reuse it unchanged), and the "shared `_client.ts`
behind two SEO-differentiated pages" pattern for any future tool that
wants a second search-intent-targeted route without a second
implementation.

## STL Repair (Phase 6)

### A repair layer on top of Phase 5's topology, never a second definition of "broken"

`/stl-repair/` (primary), `/make-stl-watertight/` and
`/repair-non-manifold-stl/` (secondary SEO routes) share one
`src/pages/stl-repair/_client.ts` orchestrator and one
`src/workers/stl-repair.worker.ts` worker. `src/lib/stl-repair/` never
re-derives what a hole, a non-manifold edge, winding, degeneracy, a
shell, or watertightness means — every one of those definitions still
lives exactly where Phase 5 put it (`src/lib/mesh/*`,
`src/lib/stl-diagnostics/analyze.ts`). Phase 6 made exactly two additive,
non-breaking extensions to that layer, both because the repair path
genuinely needed data Phase 5's diagnostics-only consumers never
required: `BoundaryComponent` gained an `edges` field (the ordered edge
list a hole-filler needs to walk a loop; diagnostics only ever needed the
component's classification), and `ShellOrientationResult` gained
`parityByTriangleIndex` (which triangles disagree with their shell's
majority winding; diagnostics only ever needed the yes/no consistency
verdict). `connected-components.ts`'s `UnionFind` was exported unchanged
for `weld.ts` to reuse for vertex-cluster resolution. No other file under
`src/lib/mesh/` or `src/lib/stl-diagnostics/` changed.

### Two-phase worker protocol: plan, then repair — never one round-trip

The existing `WorkerRequest.process.options: Record<string, unknown>`
field carries a `mode: "plan" | "repair"` discriminator; no new protocol
message type was needed. The client always calls `mode: "plan"` first,
renders the plan for the user to review, and only calls `mode: "repair"`
after an explicit "Run repair" click — the plan/repair separation is
structural (two real worker round-trips), not just a UI convention. Both
modes run through the same underlying `repairSTL()` in
`src/lib/stl-repair/repair.ts`; `"plan"` calls `planRepair()` alone and
returns before any mutation, `"repair"` calls the full pipeline. The
worker's own stage names sent back over `onProgress` are: Reading STL,
Checking original mesh, Planning repairs, Welding vertices, Removing
invalid faces, Correcting winding, Filling holes, Cleaning shells,
Writing repaired STL, Verifying repaired STL, Preparing comparison,
Ready — each one true (no stage claims to do work it hasn't started).

### The repair pipeline: analyze → plan → mutate a copy → serialize → reparse → re-diagnose → report

`repairSTL()` never trusts its own mutations: after every geometry
change it serializes a real binary STL via the unchanged
`serializeBinarySTL()`, re-parses those exact bytes with the unchanged
`parseSTL()`, and re-runs the unchanged `analyzeSTLDiagnostics()` against
the reparsed result — the same verification loop a human tester would
run, not a shortcut. Stage order (each one skippable when its
preconditions don't hold, never skippable "because it looked done
already"): checking-original-mesh → planning-repairs →
welding-vertices → removing-invalid-faces (degenerates, then duplicate
faces, welding-introduced or original) → correcting-winding → filling-
holes → cleaning-shells (small-shell removal when enabled, then a
final degenerate/duplicate cleanup pass that ALWAYS runs regardless of
whether small-shell removal ran — see Bugs fixed below) → writing-
repaired-stl → verifying-repaired-stl → preparing-comparison. The input
`Float32Array` is never mutated; every stage works on a fresh copy.

### Presets: Safe, Standard, Custom — one settings object, three ways to fill it

`safePreset()` (the default): exact float32 vertex canonicalization,
remove exact degenerates and exact duplicate faces, correct resolvable
winding, orient eligible closed shells outward, fill only closed-simple-
loop holes within the default ceilings, no welding, no small-shell
removal. `standardPreset(diagonal)`: everything Safe does, plus
tolerance-based welding at a scale-relative default
(`defaultWeldTolerance()`, derived from the mesh's own bounding-box
diagonal) and cleanup of any new degenerates/duplicates welding
introduces; small-shell removal stays opt-in even under Standard. Custom
exposes every individual toggle in `RepairSettings` directly through
`STLRepairSettings.astro`. There is no "aggressive" mode — every
operation this phase ships has the same documented, bounded policy in
every preset; nothing is ever included only because a preset name
implies more thoroughness.

### Vertex welding: exact identity is a floor, tolerance welding is opt-in and always disclosed

Exact canonicalization (bit-exact float32 + normalized signed zero) runs
in every preset, matching Phase 5's own `deduplicateVertices()` policy —
lossless, never changes geometry. Tolerance welding (`weld.ts`) is a
separate, opt-in step: a deterministic uniform spatial hash keyed on the
resolved absolute tolerance (never all-pairs), iterative `UnionFind`
clustering, and a fixed representative-selection rule — **the lowest
canonical vertex ID in each cluster**, never an average, since averaging
moves geometry the mesh never actually had. The tolerance is always
labeled in "model units" (the file's own coordinate units — never
assumed to be millimetres) and the UI always displays the fully-resolved
absolute value being used, even when it came from the scale-relative
default; it never changes silently between the plan the user reviewed
and the repair that ran. `STLREPAIR_UNSAFE_TOLERANCE` rejects a
tolerance above a fixed ratio of the mesh's own bounding-box diagonal
before any welding starts.

### Hole filling: only closed-simple loops, every rejection reported with a reason

`hole-fill.ts` walks only the boundary components Phase 5's own
`boundary-components.ts` classifies as `closed-loop` — branched,
non-simple, and (topologically-impossible-in-practice) open-chain
components are never touched. For each candidate loop: walk the ordered
edge list into a unique vertex sequence, estimate a stable plane via the
same Newell's-method plane fit `mesh/triangulate.ts` already used for
Phase 5's own self-intersection work, measure planarity deviation and
reject loops that deviate too far, reject self-intersecting boundaries,
and triangulate via the *unchanged* `triangulatePolygon()` (convex fan or
ear-clipping, whichever the loop needs — including genuinely concave
loops, verified end-to-end in this phase's own browser testing, not only
at the unit level). The resulting patch's winding is matched against the
one adjacent triangle already touching the loop, never guessed. Every
loop that exceeds a configured ceiling (vertex count, perimeter, area,
planarity deviation) or fails validation is **skipped and reported with
its specific reason** — filling is never forced.

### Winding correction: one combined pass, never two that could oscillate

`winding.ts` reuses `orientation.ts`'s own BFS parity propagation
per-shell, then for shells that are additionally closed, orientable, and
have a well-defined non-zero signed volume, XORs each triangle's
propagation-derived flip with a single whole-shell "face outward"
decision — one combined flip decision per triangle, not two independent
passes that could disagree. Open shells get only the internal-
consistency half; the pipeline never claims an outward orientation it
can't verify. Binary STL facet normals are always recomputed from the
repaired geometry on serialization — stored source normals are never
trusted or round-tripped.

### Non-manifold and self-intersection: deterministic cases are fixed, everything else is honestly left alone

Non-manifold edges caused by exact duplicate/degenerate faces are
resolved as a side effect of the duplicate/degenerate cleanup passes
above. Beyond that, this phase **never deletes an arbitrary triangle
just to force an edge's incidence count down to two** — an edge that
remains non-manifold after cleanup is left exactly as-is and reported in
`unresolvedProblems`, and the outcome for such a mesh is honestly
`unable-to-repair-safely`, never anything that implies a fix.
Self-intersection resolution is **detect-only** this phase: Phase 5's own
self-intersection analysis still runs on both the before and after mesh,
and an unresolved self-intersecting pair is always reported by name in
`unresolvedProblems`, never silently dropped from the comparison.

### Outcomes: seven honest states, "fully-repaired" is the hardest one to earn

`outcome.ts` compares the ACTUAL reparsed-and-rediagnosed after-state
against the before-state, never the set of operations attempted.
`fully-repaired` requires the before mesh to have NOT been watertight,
the after mesh to verify watertight against the real reparsed output, the
self-intersection check to have completed (not been skipped or
budget-cut), and zero entries in `unresolvedProblems`. `unchanged`
requires zero problems before AND after, plus no degenerate-count or
inward-shell-count change (an inward→outward fix or a degenerate
cleanup is a real improvement even when it doesn't move the watertight
verdict, so it is never reported as `unchanged`). `improved` and
`partially-repaired` both represent genuine forward progress;
`partially-repaired` is used specifically when something was also
skipped or left unresolved alongside that progress. `unable-to-repair-
safely` is used when nothing this phase's operations could safely change
actually changed. `failed` and `cancelled` cover thrown errors and
user/worker cancellation.

### Overlays: precise where the answer is free, diffed where full attribution isn't worth the cost

`overlays.ts` builds bounded before/after visualization buffers two
ways: hole-fill's and shell-cleanup's own added/removed triangles are
captured directly at the point they're known (a tail-slice for
hole-fill's always-appended patches, a direct pass-through for
shell-cleanup's own removed-shell positions) — exact and free.
Welded/removed/flipped geometry elsewhere in the pipeline is instead
identified by position-key diffing between the before and after vertex
sets. This is a disclosed simplification: it identifies WHAT changed,
not which specific stage changed it, when more than one stage touches
the same region. No stage was rearchitected to thread full per-triangle
provenance through the whole pipeline for this phase.

### Reports and downloads: a real binary STL, plus a JSON report with no raw geometry

The repaired file downloads through the same `serializeBinarySTL()`
every other tool uses, named `<original-name>-repaired.stl`. The JSON
report (`report.ts`, schema-versioned like every other tool's own
report) includes settings, before/after diagnostic summaries, attempted/
skipped operations with reasons, timing, and limitations — and explicitly
never includes raw triangle coordinates, source file bytes, arbitrary STL
header text, local file paths, or stack traces, verified directly by
`report.test.ts`.

### Bugs found and fixed by this phase's own tests before merge

Two real pipeline bugs were caught by test assertions, not by manual
inspection. First, the final degenerate/duplicate cleanup pass was
nested inside the small-shell-removal branch, so it silently never ran
under the Safe preset (small-shell removal is off by default) — a
`repeatedPositionDegeneracy()` repair test expected one surviving
triangle and got two, traced to hole-filling correctly patching a
trivially-closed single triangle's own 3-edge boundary and creating a
duplicate that should have been, but wasn't, cleaned up. Fixed by making
the final cleanup pass unconditional. Second, `determineOutcome()`
didn't account for an inward→outward shell-orientation fix, since that
change doesn't move `problemCount` — an `inwardClosedCube()` repair test
expected `"improved"` and got `"unchanged"`. Fixed by adding
inward-shell-count comparison to both the `unchanged` gate and the
`improved` trigger. A separate, non-bug finding from browser testing:
Standard-preset welding with the client's auto-computed default
tolerance can be smaller than a fixture's actual seam gap, in which case
hole-filling still correctly and independently patches each resulting
shell's own boundary, producing a technically watertight result that
is still multiple disconnected shells — both behaviors are individually
correct, so the fix was transparency, not logic: `STLRepairComparison`
gained a Shells row so this outcome is always visible, never silently
hidden behind a "watertight" verdict.

## Known limitations (Phase 6)

- **Self-intersection resolution is detect-only.** An unresolved
  self-intersecting pair is always named in `unresolvedProblems`; no
  operation in this phase attempts to resolve one.
- **Non-manifold edges beyond deterministic duplicate/degenerate cleanup
  are left unresolved, not force-fixed.** No triangle is ever deleted
  solely to force an edge's incidence count to two; the result may
  legitimately remain "improved but still non-manifold."
- **Welding uses a fixed representative-selection rule (lowest canonical
  vertex ID), never averaging.** A cluster's merged position is always
  one of its original vertex positions, never a computed midpoint.
- **The default weld tolerance can under-close a seam.** It is
  scale-relative to the mesh's own bounding-box diagonal and always
  displayed and adjustable, but a genuinely tight-but-real gap can still
  end up wider than the computed default; the Shells comparison row
  makes this visible when it happens.
- **Overlay buffers identify WHAT changed via position-key diffing for
  welded/removed/flipped geometry (not hole-fill or shell-cleanup, which
  are captured exactly), not which pipeline stage changed it**, when more
  than one stage touches the same region.
- **No batch or multi-file repair, and no saved/reusable custom presets**
  — this phase repairs exactly one file per run; batch repair is
  disclosed in-product as a planned Pro direction, not built.
- **A recurring `net::ERR_FILE_NOT_FOUND` console entry appears on
  nearly every page load during dev-server testing.** Investigated
  repeatedly: it never correlates with any tracked network request and
  never affects any verified functional result. Not fully root-caused;
  disclosed here rather than silently ignored or falsely claimed absent.

## Phase 6 completion summary

`/stl-repair/` (primary), `/make-stl-watertight/` and
`/repair-non-manifold-stl/` (secondary SEO routes, same shared
`_client.ts` and worker) are now `"ready"` in the tool registry.
`src/lib/stl-repair/` adds vertex welding, degenerate/duplicate-face
cleanup, winding correction, hole filling, small-shell cleanup, outcome
determination, and reporting — all built strictly on top of Phase 5's
existing, unmodified topology and diagnostics definitions, with only two
additive, backward-compatible fields added to `src/lib/mesh/` for data
the repair path genuinely needed. Every repair is verified against its
own actual serialized-and-reparsed output before any outcome is reported
to the user — never against the attempted operations alone. 90 test
files / 1,124 tests pass (up from Phase 5's baseline), including 15
end-to-end `repairSTL()` tests that each validate their output through
the real production parser and Phase 5's own `analyzeSTLDiagnostics()`,
plus dedicated suites for welding, cleanup, winding, hole-filling
(including a concave-loop case and a self-intersecting-boundary
rejection case), shell cleanup, planning, outcome determination, and
report generation. `astro check` reports 0 errors/0 warnings/0 hints
across 357 files, and the production build emits all three repair pages,
a `stl-repair.worker` chunk, correct canonical URLs and structured data
per page, and no repair-related references in the homepage bundle.
Two real pipeline bugs (see above) were found and fixed by this phase's
own tests before merge.

## Launch SEO (Phase 7)

### An audit-and-fix phase, not a new-tool phase — everything routes through `dist/`, never Astro source alone

Phase 7 added no new converter, viewer, diagnostic or repair code. Its own
new code is entirely audit tooling: `scripts/seo-audit/*.mjs` (pure,
independently unit-tested modules — `route-manifest.mjs`, `url-utils.mjs`,
`html-utils.mjs`, `checks.mjs`, `sitewide-checks.mjs`,
`content-accuracy.mjs`) plus `scripts/audit-seo.mjs`, the thin orchestrator
`npm run seo:audit` runs. The orchestrator always builds first, then
parses the real `dist/**/*.html`, `dist/sitemap-*.xml` and
`dist/robots.txt` output with `linkedom` (a small, dependency-light DOM
implementation added this phase for exactly this — the project had no
HTML parser before) — deliberately never trusting Astro component props
directly, since a prop can be right while the rendered output is still
wrong. `scripts/seo-audit/route-manifest.mjs` is the one hand-authored
piece: an explicit classification for every route (`indexable-primary`,
`indexable-intent-page`, `canonical-alias`, `noindex-utility`,
`development-only`), cross-checked by its own test against the real
`src/pages/*/index.astro` glob so the manifest and the repo can't
silently drift apart. See `docs/SEO-PAGE-INVENTORY.md` for the full route
table this manifest generates, and `docs/SEO-LAUNCH-CHECKLIST.md` for
what every check means, its current pass/fail state, and the
post-deployment Search Console steps this phase documents but never
executes.

### The one real launch blocker: `siteConfig.siteUrl` is still `https://example.com`

Every canonical URL, sitemap entry, Open Graph URL/image and
structured-data URL on the site derives from this single centralized
value (`src/config/site.ts`'s `siteUrl`, mirrored in `astro.config.mjs`'s
`site`). This phase's own explicit instruction was to never invent a
domain, so it didn't — instead, `scripts/seo-audit/url-utils.mjs`'s
`isPlaceholderOrigin()` detects `example.com`/`localhost`/bare IPs and the
audit reports a single, loud `LAUNCH BLOCKER` critical finding plus one
finding per domain-dependent field it can't fully validate (currently 43
of 43 critical findings — every single one traces back to this one root
cause; zero unrelated critical findings, zero warnings). `robots.txt`
itself was converted from a static `public/robots.txt` file to a dynamic
endpoint (`src/pages/robots.txt.ts`, prerendered like any other static
route) specifically so its `Sitemap:` line reads `siteConfig.siteUrl`
directly and can never separately drift from the two config lines once a
real domain is finally set.

### Homepage staleness: the fix is "derive from the registry," not "hand-edit the copy again"

The homepage previously hardcoded a `tools` array that included a
**"G-code Viewer" card that was never built** (no G-code tool exists
anywhere in `src/config/tools.ts` or `src/pages/`), a "Also planned: OBJ
to STL · GLB to STL · STL to OBJ · FBX Viewer · PLY Viewer" line
describing five tools that had actually **shipped** by the time this
phase ran, a hardcoded "7+" tool count (actual: 18), and FAQ copy naming
"G-code" as a launch format. `src/pages/index.astro` now derives every one
of these facts from `toolRegistry` at build time — `readyTools.length`
for the count, `readyTools.flatMap(t => t.inputFormats)` (deduplicated)
for the format list, and a computed `plannedTools` list for the "planned
next" line, which is empty-safe (renders nothing if every planned tool
ships). The four featured tool cards are still an editorial choice (which
four to spotlight is not derived from anything), but every *fact* about
each chosen tool — its name, its own page path — comes from
`getToolById()`, never a second hand-typed copy. Each "also live" tool
name is now a real crawlable link to its own page too, not inert text —
a direct, if incidental, internal-linking improvement alongside the
staleness fix.

### `RelatedTools.astro`: one shared component, built because `/stl-viewer/`'s own version had actively drifted wrong

Most tool pages' own hand-rolled "related tools" `Fragment` already
guarded correctly (`tool.status === "ready" ? <a> : <span>`). `/stl-viewer/`
did not: it hardcoded every related tool as unlinked "Planned" text under
a "Related planned tools" heading — true when Phase 2 first wrote it
(everything else really was planned then), false by the time five of its
related tools had shipped in later phases, and never revisited.
`src/components/tools/RelatedTools.astro` is the fix: one component,
built once, using the correct guard, that `/stl-viewer/` now uses instead
of its own copy. The other 17 pages' own duplicated (but currently
correct) Fragments were deliberately left as-is rather than mechanically
replaced everywhere — a documented, low-risk scope decision, not an
oversight; see `docs/SEO-PAGE-INVENTORY.md`'s "Known, accepted exception"
note.

### `relatedToolIds` reciprocity: found by a test, not by inspection

`src/config/tools.test.ts`'s reciprocity test — "a ready tool's related,
ready tools link back to it" — failed on first run with **25 real
one-directional relationships** (e.g. `obj-viewer` listed `stl-viewer` as
related, but `stl-viewer` didn't list `obj-viewer` back). Every viewer,
converter and diagnostic/repair tool's `relatedToolIds` array was updated
to close these gaps, verified by rerunning the same test to a clean pass.
This is now a standing regression test: any future tool addition that
creates a new one-directional relationship fails `npm run test`
immediately, rather than silently shipping an asymmetric internal-link
graph the way the original registry did.

### Content-accuracy scanning: text-pattern matching, with one real false positive found and fixed

`scripts/seo-audit/content-accuracy.mjs`'s `scanForStaleClaims()` greps
rendered page text for guaranteed-repair language, "100% repair," unsupported
"best" superlatives, AI/ML claims, server-upload claims, and references to
the nonexistent G-code Viewer. Its first real run against the built site
flagged `/stl-repair/`'s own limitations section — "It **cannot
guarantee** printability" — as a guaranteed-printability claim, which is
backwards: that sentence is the honest disclaimer this whole project's
own conventions require, not a marketing claim. Fixed with a negative
lookbehind excluding `cannot/can't/never/won't/does not/doesn't/no` before
`guarantee`, with both the original false-positive case and the fix
covered by dedicated test cases in `content-accuracy.test.mjs` — a
reminder that a text-pattern scanner needs to handle negation explicitly,
not just positive phrase matches.

### Heading hierarchy: two components fixed, five pages affected

The audit's `checkHeadings()` caught a real semantic-structure defect:
`STLDiagnosticsDetails.astro`'s "Boundary breakdown"/"Shells"/"Analysis
timing" subsection headings and `STLRepairPlan.astro`'s "Planned
operations" heading were all `<h3>`, but each renders inside a page's
`results` slot — which appears in DOM order *before* the page's own
`seo-content` slot's first `<h2>`. The result was a real `<h1>` → `<h3>`
skip on every page using either component (`/stl-checker/`,
`/stl-validator/`, `/stl-repair/`, `/make-stl-watertight/`,
`/repair-non-manifold-stl/`). Both components' section headings were
bumped to `<h2>` — no dedicated tag-based CSS existed for either
selector, so this was a safe, purely-structural fix with no visual
redesign.

### Open Graph: every page went from *zero* `og:image` to a shared default, honestly labelled

No page in the entire site passed `SEOHead.astro`'s `socialImage` prop
before this phase — every page's Open Graph preview had **no image at
all**. `SEOHead.astro` now defaults `socialImage` to
`siteConfig.defaultSocialImage` (`/mesh-hero.png`) and always emits
`og:image:width`/`og:image:height`/`og:image:alt` plus `twitter:image`/
`twitter:image:alt` — using the image's own real pixel dimensions
(1254×1254, corrected from a pre-existing, unrelated `width="1280"
height="1280"` mismatch on the homepage's own `<img>` tags, itself a
minor layout-shift-risk bug fixed alongside this) rather than the
1200×630 baseline the file doesn't actually have. One shared image across
every page (never a bespoke asset per tool, which the project has no
tooling to generate or maintain) is a deliberate, disclosed scope
decision — see "Known limitations" below.

## Known limitations (Phase 7)

- **The production domain is still a placeholder.** This is the single
  launch blocker; see `docs/SEO-LAUNCH-CHECKLIST.md`'s own top section.
  Nothing else in this phase is gated on it except the fields that
  literally embed the domain (canonical, sitemap, OG/structured-data
  URLs).
- **One shared Open Graph image for every page**, not a bespoke image per
  tool or tool family. The site has no image-generation tooling and this
  phase didn't add any (adding an image-processing dependency purely for
  static OG assets was judged out of proportion to this phase's scope);
  `mesh-hero.png` is also a 1254×1254 square, not the 1200×630 landscape
  baseline most platforms render best — declared honestly via real
  `og:image:width`/`height` rather than the (wrong) 1200×630 default.
- **No local Lighthouse or axe-core run was added this phase.** The
  audit's own structural checks (bundle isolation, no new render-blocking
  scripts, explicit image dimensions, correct lazy-loading policy,
  landmark/heading/label presence) cover the SEO-relevant and
  easily-automatable subset of performance and accessibility, but not a
  full Core Web Vitals lab measurement or WCAG scan. Documented as a
  genuine gap, not silently skipped — see the checklist doc's own
  Performance and Accessibility sections for exactly what was and wasn't
  covered instead.
- **17 of 18 tool pages still duplicate their own "related tools" markup**
  rather than using the new shared `RelatedTools.astro` component (only
  `/stl-viewer/` was migrated, because only it had an actual bug). Safe
  today — enforced by the `relatedToolIds`-reciprocity test — but a
  documented consolidation opportunity, not a defect.
- **No Search Console verification, sitemap submission, or indexing
  request was performed** — impossible without a real domain, and
  explicitly out of scope for this phase regardless. The exact
  post-deployment sequence is documented, not executed, in
  `docs/SEO-LAUNCH-CHECKLIST.md`.

## Phase 7 completion summary

The homepage, `robots.txt`, `SEOHead.astro`, the tool registry's
`relatedToolIds` graph, two components' heading structure, and three
pages' meta-description lengths were audited and corrected. New,
independently unit-tested audit infrastructure (`scripts/seo-audit/*.mjs`,
run via `npm run seo:audit`) inspects the real `dist/` build output — not
Astro source alone — for title/description uniqueness, canonical
correctness, structured-data validity (including visible-content
agreement for FAQ schema), sitemap/robots agreement, a broken-link/orphan
internal-link-graph check, Open Graph completeness, and a content-accuracy
scan for unsupported claims. `docs/SEO-PAGE-INVENTORY.md` documents the
resulting 20-route classification table (18 indexable, 1 development-only,
1 redirect-alias) generated from real audit output; `docs/SEO-LAUNCH-CHECKLIST.md`
documents every check's current pass/fail state and the not-yet-executed
post-deployment Search Console sequence. All 1,211+ existing and new unit
tests pass, `astro check` remains clean, and the production build emits
all 20 routes correctly. The single remaining launch blocker — a
placeholder production domain — is loudly reported by the audit rather
than silently shipped, exactly as instructed; every other check passes
cleanly.

## Step 0 (Phase 8): homepage Pro `Offer` removed from structured data

Before any Phase 8 feature code, the Phase 7 readiness audit's own
structured-data finding was fixed as a stabilization regression, TDD-first:
a failing test in `scripts/seo-audit/checks.test.mjs` proved the
homepage's `WebApplication` JSON-LD must never emit a priced `Offer` while
no checkout, license product or payment implementation exists anywhere in
the codebase (confirmed by the same repo-wide search the readiness audit
itself used). `checkStructuredData()` in `scripts/seo-audit/checks.mjs`
now rejects any `Offer` whose price isn't exactly `0` unless it carries
`"availability": "https://schema.org/PreOrder"` — schema.org's own
"not yet purchasable" vocabulary, deliberately not used here since no real
preorder flow exists either. `src/pages/index.astro` now emits only the
real, usable `{price: "0", ...}` offer; the visible Pro pricing copy
("planned price is $39 once") was already honestly hedged and needed no
change. Verified: `npm run seo:audit` reports the identical 0 non-domain
critical / 0 warnings result as before the fix.

## STL Optimization (Phase 8)

### A conservative quadric-error-metric (QEM) edge-collapse simplifier, built through strict TDD

`src/lib/mesh-optimization/` is Phase 8's own new library — every module
was written test-first (a failing test confirmed red, then the minimum
implementation to turn it green) rather than implemented and tested after
the fact. It reuses Phase 5's `src/lib/mesh/*` topology layer completely
unchanged for input analysis (`canonical-vertices.ts`, `edge-incidence.ts`,
`connected-components.ts`, `boundary-components.ts`) and Phase 6's
`stl-repair/types.ts`'s own `DiagnosticsSummary`/`summarizeDiagnostics()`
for its before/after comparison — no new topology definitions, no second
STL reader. The library's own new pieces:

- **`quadric.ts`** — the QEM math (Garland & Heckbert): a quadric is the
  symmetric 4×4 matrix `p·pᵀ` for a plane `p=[a,b,c,d]`, stored as its 10
  unique upper-triangular entries. `solveOptimalPosition()` solves the
  3×3 linear system via Cramer's rule and reports `ok: false` (never a
  guessed answer) whenever the matrix is singular.
- **`indexed-mesh.ts`** — the mutable in-worker mesh representation,
  built once from Phase 5's own `CanonicalMesh`/`EdgeIncidence`/
  `TriangleShells` (never re-deriving vertex/edge/shell identity).
  `collapseEdge()` is the one function that actually mutates anything;
  every vertex/triangle id is exactly Phase 5's own dense canonical
  index, so "deterministic ids" falls out of reuse rather than a new
  numbering scheme.
- **`collapse-validation.ts`** — the safety policy, checked before every
  single collapse: finite coordinates, same-shell membership, the
  boundary policy (below), the manifold **link condition** (a collapse
  is safe iff `neighbors(a) ∩ neighbors(b)` equals exactly the third
  corners of the ≤2 triangles already containing edge `(a,b)` — any
  other shared neighbor means merging would pinch the surface into a
  non-manifold vertex elsewhere), no new degenerate or duplicate
  triangles, a configurable max normal-flip angle, and a per-shell
  minimum triangle floor.
- **`collapse-heap.ts`** — a binary min-heap with deterministic
  cost-then-edge-key tie-breaking and a **lazy invalidation** contract:
  it never rebuilds or resorts globally after a collapse; each candidate
  carries the mesh's `version` at insertion, and a stale pop is
  recomputed and re-pushed in place, one entry at a time.
- **`edge-candidates.ts`** — builds/regenerates candidates via QEM
  scoring. A collapse's surviving vertex quadric is always the SUM of
  the two merged vertices' quadrics (the standard QEM update rule, never
  recomputed from scratch), and `regenerateLocalCandidates()` only ever
  touches the surviving vertex's own current neighbor edges — never a
  global rebuild.
- **`simplify.ts`** — the main loop: pop cheapest, discard/refresh if
  stale, validate, apply, regenerate locally, repeat, with explicit
  bounded stop reasons (`target-reached`, `no-safe-collapses-remain`,
  `work-budget-reached`, `collapse-attempt-limit-reached`,
  `candidate-heap-exhausted`, `cancelled`) — never an unbounded "keep
  trying" loop.
- **`deviation.ts`** — sampled geometric deviation: each mesh's own
  vertices and triangle centroids are checked against the OTHER mesh's
  nearest surface point (a barycentric closest-point-on-triangle
  calculation, accelerated by a purpose-built uniform spatial grid — the
  same bucketing strategy `mesh/spatial-index.ts` uses, adapted to a
  nearest-point query rather than triangle-pair candidates). Always
  labelled "sampled geometric deviation," never Hausdorff distance,
  since only a bounded sample is checked, not the full surface.
- **`plan.ts`** / **`outcome.ts`** / **`report.ts`** / **`formatting.ts`**
  — eligibility classification, the honest outcome-state policy, and the
  downloadable JSON report, following the exact same shape as their
  `stl-repair/` counterparts. The JSON report's `surfaceArea` and
  `volume` objects and its `appliedThresholds`/`thresholdCheck` fields
  mirror `OptimizeResult`'s own fields exactly — see "Surface-area and
  closed-shell volume comparison (Phase 8 closeout)" below.
- **`volume-surface.ts`** (Phase 8 closeout) — `computeSurfaceArea()`,
  `compareSurfaceArea()`, `classifyMeshVolume()`, `compareVolume()`, and
  `checkThresholds()`. See the dedicated section below for the full
  contract.

### Boundary policy (documented, precisely)

A collapse is only ever allowed between two boundary vertices that are
**adjacent on the same closed boundary loop** (a real boundary edge of a
`closed-loop` component from `mesh/boundary-components.ts` — open-chain,
branched and non-simple components are never eligible, the same
closed-simple-only policy Phase 6's hole-filling uses). A boundary vertex
may never collapse into an interior vertex. Collapsing two loop-adjacent
vertices can only ever shorten that one loop by one vertex — it can never
join two loops or split one, since a non-adjacent pair is rejected
outright.

### Shell policy

Every candidate edge is generated only within a single shell (same
`vertexShellId`), and `collapse-validation.ts` independently re-checks
this — belt-and-suspenders, not redundant, since the check is cheap and
the invariant (shell count is preserved by default) is exactly what
"never delete an entire disconnected shell as a side effect" depends on.
A `minTrianglesPerShell` floor (default 4, the smallest possible closed
shell) additionally protects a small shell from being collapsed away
entirely even when nothing else blocks it.

### Presets

`QUALITY_PRESETS` (`types.ts`) resolves "Preserve details" / "Balanced" /
"Maximum reduction" to concrete `maxNormalFlipAngleDeg` values (15° / 35°
/ 60°) — the ONE knob that actually gates collapses today; a preset never
disables the underlying topology-safety checks, only how far a surviving
triangle's normal may rotate before a collapse is rejected. Verified in
browser: a 12-triangle sharp cube under "Preserve details" with a 50%
target reports `unchanged-no-safe-collapses` rather than rounding off a
90° edge — the exact "sharp cube edges must not be rounded away" case.

### Outcome states and mandatory verification

Same evidence-based posture as Phase 6: `optimizeSTL()` (`optimize.ts`)
always serializes a real binary STL, re-parses those exact bytes, and
re-runs `analyzeSTLDiagnostics()` on the reparsed output before
`outcome.ts` decides anything. `target-achieved` requires the reparsed
output's own triangle count at or below the resolved target, every safety
invariant holding (shell count unchanged; boundary/non-manifold/winding/
duplicate/degenerate counts never increased; a watertight input stays
watertight), a completed self-intersection check, and a completed
deviation measurement. An unachievable target never throws or reports
`failed` — it reports `partially-reduced` (real progress made) or
`unchanged-no-safe-collapses` (nothing safe to remove), always with the
actual achieved count, never a false `target-achieved`.

### Routes: two, not four

The task's own SEO-routes section suggested `/reduce-stl-file-size/`
(primary), `/simplify-stl/`, `/stl-triangle-reducer/` and
`/stl-mesh-optimizer/`. This phase built the primary plus TWO intent
routes, not three, and documents that decision here rather than silently
shipping a smaller set: `/simplify-stl/` (a modeling/detail-reduction
framing) and `/stl-triangle-reducer/` (a technical, slicer-error-driven
framing — "too many facets") target genuinely distinct search intent and
got genuinely distinct copy and FAQ sets. A fourth route,
`/stl-mesh-optimizer/`, would have targeted "optimize STL for slicing" —
semantically overlapping both `/reduce-stl-file-size/` (file-size framing)
and `/simplify-stl/` (mesh-detail framing) closely enough that shipping it
risked exactly the keyword-cannibalization problem Phase 7's own SEO
audit was built to catch, for marginal additional search coverage. All
three built routes mount the exact same `reduce-stl-file-size/_client.ts`
orchestrator and the same five `STLOptimize*.astro` components — one
engine, never a second implementation.

### Worker and UI

`src/workers/stl-optimizer.worker.ts` mirrors `stl-repair.worker.ts`'s
exact two-mode shape (`mode: "plan"` parses+diagnoses+classifies
eligibility only; `mode: "optimize"` runs the full pipeline) through the
same existing `process.options` field — no new protocol surface.
`STLOptimizeSettings/Plan/Result/Comparison/Controls.astro` follow the
same presentation-only, `data-*`-filled-by-`_client.ts` pattern every
prior tool uses. Requested vs. achieved reduction are always two
separately labelled numbers, never merged into one.

## Known limitations (Phase 8)

- **No visualization overlay buffers** (removed/collapsed-region
  highlighting on the 3D model) — unlike Phase 6's repair overlays, this
  phase's `OptimizeResult` carries no bounded overlay geometry.
  `STLOptimizeControls.astro` has no overlay-toggle buttons as a direct
  consequence. The before/after numeric comparison table and the
  original/optimized model toggle are the only comparison UI this phase
  ships.
- **Sharp-feature detection is threshold-based, not edge-tagged** — a
  preset's `maxNormalFlipAngleDeg` protects sharp features as a side
  effect of the general normal-flip guard; there is no separate explicit
  sharp-edge-angle detection pass tagging specific edges as "protected"
  ahead of time (`sharpEdgeAngleDeg` exists in `QualityPreset` but isn't
  yet consumed by a dedicated feature-detection step).
- **Deviation sampling uses a fixed per-mesh sample budget** split evenly
  between the original and optimized mesh's own vertices+centroids —
  not a fully adaptive or exhaustive sampling strategy.

## Surface-area and closed-shell volume comparison (Phase 8 closeout)

`src/lib/mesh-optimization/volume-surface.ts` computes both metrics from
the production-parsed ORIGINAL geometry and the REPARSED SERIALIZED
OUTPUT geometry only — never an intermediate mutable mesh:

- **Surface area** (`computeSurfaceArea()`) sums each triangle's own area
  directly from a flat positions buffer; always a real number for any
  valid mesh.
- **Closed-shell volume** (`classifyMeshVolume()`/`compareVolume()`)
  reuses Phase 5's already-computed `STLDiagnosticsReport.shells` /
  `ShellSummary.signedVolume` unchanged — no second volume definition. A
  mesh-wide volume is only ever reported (`volumeStatus: "completed"`)
  when EVERY shell is closed, consistently orientable, and determinately
  oriented; a single open or indeterminate shell makes the WHOLE model's
  volume `"not-applicable"` or `"indeterminate"` (with a `volumeReason`)
  rather than silently reporting a partial sum. The reported figure is
  the SUMMED MAGNITUDE of each eligible shell's own `|signedVolume|` —
  never Phase 5's own signed net total, since MeshKit's shells represent
  separate solid parts, not nested cavities. `0` is never displayed when
  volume isn't meaningful — `volumeBefore`/`volumeAfter` are `null`.

### Preset quality-policy thresholds

Each `QualityPreset` (`types.ts`) carries its own
`maxSurfaceAreaChangePercent` / `maxVolumeChangePercent` limits — **these
are MeshKit's own disclosed quality policy, not manufacturing tolerances
or any external standard**:

| Preset | Max surface-area change | Max volume change |
| --- | --- | --- |
| Preserve details | 3% | 2% |
| Balanced | 12% | 8% |
| Maximum reduction | 35% | 25% |

`checkThresholds()` (`volume-surface.ts`) compares a result's own
measured percentage change against the active preset's limits — the
volume threshold is only ever enforced when volume was actually
measurable on both sides (`volumeStatus === "completed"`), so open or
indeterminate geometry never produces a false threshold failure.
Exceeding either threshold is a real, detected policy violation on the
VERIFIED (reparsed) output: `determineOutcome()` (`outcome.ts`) caps the
outcome to `verification-failed` — exceeding a threshold can never
produce `target-achieved` or `reduced-safely`, and `thresholdCheck.
reason` explains which threshold failed. The applied thresholds are
surfaced in the plan (`OptimizePlan.appliedThresholds`, visible before
anything runs), the result (`OptimizeResult.appliedThresholds` /
`.thresholdCheck`), and the downloadable JSON report
(`DownloadableOptimizeReport.appliedThresholds` / `.thresholdCheck`).

## Phase 8 completion summary

`src/lib/mesh-optimization/` (14 modules, built strictly test-first) adds
a deterministic QEM edge-collapse simplifier reusing Phase 5's topology
layer and Phase 6's diagnostics-summary shape unchanged. `/reduce-stl-
file-size/` (primary), `/simplify-stl/` and `/stl-triangle-reducer/`
(two, not four, secondary routes — see the documented decision above)
are now `"ready"` in the tool registry, sharing one worker and one client
orchestrator. Every optimization is verified against its own reparsed,
re-diagnosed output before any outcome is reported; manifold topology,
boundary loops and shell count are preserved by default and enforced by
the collapse-validation safety policy (the link condition, boundary-loop
adjacency, and per-shell minimums). Two real bugs were caught by tests
before merge (see the completion report's TDD discoveries), plus the
Step-0 stabilization fix for Phase 7's own structured-data finding. All
tests pass, `astro check` is clean, and the production build emits all
23 routes plus the new `stl-optimizer.worker` chunk with zero non-domain
SEO regressions.

**Closeout addendum:** surface-area and closed-shell volume comparison,
preset quality-policy thresholds, and the FBX Viewer's own browser smoke
test (see above) were completed in a follow-up TDD pass after the phase's
initial merge — see this document's own "Surface-area and closed-shell
volume comparison" section and `docs/PRODUCT-READINESS-AUDIT.md`'s Phase
8 addendum for the exact results.

## G-code Cluster (Phase 9)

The first phase to touch G-code at all. G-code is fundamentally different
from every format handled before it — it's a stateful INSTRUCTION
STREAM, not a triangle mesh, so `src/lib/mesh/*` doesn't apply. A
dedicated engine, `src/lib/gcode/` (20 modules, built strictly
test-first, ~340 tests), parses, resolves, classifies and packs a G-code
file into render buffers a shared Three.js client renders across five
intent routes: `/gcode-viewer/` (primary), `/gcode-visualizer/`,
`/gcode-simulator/`, `/gcode-layer-viewer/`, `/gcode-toolpath-viewer/` —
one parser/worker/renderer/client, five SEO-differentiated pages around
it (mirroring Phase 8's own one-engine-many-routes pattern).

This is a **static viewer, visualizer and visual playback simulator
only** — it never executes a G-code command, never uses WebSerial, never
connects to any device, and playback never claims to exactly reproduce
physical printer motion. It is not a slicer: MeshKit never claims an STL
can be converted to G-code.

### Module pipeline

`chunked-lines.ts` → `tokenizer.ts` → `checksum.ts` / `comments.ts` →
`modal-state.ts` → `linear-moves.ts` / `arcs.ts` → `extrusion.ts` →
`layers.ts` / `features.ts` → `statistics.ts` / `timing.ts` →
`geometry.ts` → `playback.ts`, orchestrated by `analyze.ts` in ONE
sequential pass (a second, cheap O(n) pass only assigns each already-
computed segment's `layerIndex` from the layer boundaries `layers.ts`
needs the whole file's events to resolve — never a second parse of the
raw text).

- **`chunked-lines.ts`** — `ChunkedLineDecoder`, a bounded streaming line
  decoder built on `TextDecoder`'s own `{ stream: true }` mode (the
  browser-native mechanism for resolving a multibyte UTF-8 sequence split
  across chunk boundaries). Strips a leading BOM, handles LF/CRLF/a final
  line with no trailing newline, and truncates-and-resyncs on an
  excessively long line rather than buffering it in full.
- **`tokenizer.ts`** — pure lexical scanning: case-insensitive letter/
  number words, no-mandatory-spaces support, `N`-prefixed line numbers,
  `*`-suffixed checksums, bounded semicolon/parenthetical comments,
  scientific notation, and a malformed token is counted and skipped —
  never thrown, never crashes the line.
- **`checksum.ts`** — the classic RepRap/Marlin XOR checksum
  (`valid`/`missing`/`mismatched`); never rejects a file itself — the
  viewer defaults to warning, never aborting an otherwise inspectable
  file (checksum validity says nothing about print safety).
- **`modal-state.ts`** — explicit state (position, unit mode, axis/
  extruder positioning, workspace plane, active tool + per-tool E,
  feed rate, temperatures, fan, speed/flow factors, volumetric flag).
  **Documented G90/G91 vs. M82/M83 policy**: axis positioning and
  extruder positioning are tracked as fully INDEPENDENT modes — G90/G91
  never implicitly changes extruder positioning. This matches every
  slicer in this project's supported dialect scope (Cura, PrusaSlicer,
  OrcaSlicer, Bambu Studio all emit M82/M83 independently of G90/G91,
  which is exactly why those separate commands exist), not a claim about
  every historical bare-Marlin configuration.
- **`linear-moves.ts`** — G0/G1. Classifies each move from its ACTUAL
  computed E delta (never merely whether an E token was present) into
  one of 7 mutually-exclusive, documented categories (extrusion / travel
  / retract / e-only-extrusion / e-only-retract / z-only / zero-length-
  state-update); an omitted axis never moves, in either positioning mode.
- **`extrusion.ts`** — sequence-aware: the first positive-E move after
  one or more retractions is relabeled `"prime"` — context a single
  move's own category can't carry.
- **`arcs.ts`** — G2/G3. Resolves I/J/K (always incremental offsets,
  independent of G90/G91) or R-form center/radius, all three planes
  (G17/18/19), helical Z and E interpolation, then subdivides into
  bounded render segments using a documented chord-error policy (never
  fewer than a safety floor, never more than `maxSegmentsPerArc` — a
  ceiling hit is flagged, not silently coarsened without disclosure). A
  genuinely invalid arc (impossible radius, undetermined center, an I/J/K
  endpoint inconsistent with its declared center) is reported with ZERO
  segments and an honest reason — **never silently drawn as a straight
  line**. R-form center selection reuses the standard grbl `mc_arc`
  formula (positive R sweeps ≤180°, negative R sweeps >180°) — this
  session's own TDD caught the sign condition inverted on first
  implementation; the fix is covered by dedicated short/long-way tests.
- **`comments.ts`** / **`dialect.ts`** — representative (not exhaustive)
  comment adapters for Cura, PrusaSlicer, OrcaSlicer and Bambu Studio
  (layer markers, `TYPE:`/`FEATURE:` labels, estimated time, filament
  used, model bounds); every numeric value is `Number.isFinite`-checked
  before being trusted. Dialect inference is `"unknown"`/low-confidence
  unless an explicit generator-header comment was actually seen.
- **`layers.ts`** — prefers a file's own explicit layer markers
  (uniformly, across all three slicer conventions) over inference; when
  none exist, infers purely from EXTRUSION-category moves' own Z (a
  travel/Z-only move's Z is never even considered, so a Z-hop can never
  create a false layer). A near-continuous Z change on >80% of extrusion
  moves (spiral/vase printing) is recognized as non-planar and never
  reported as conventional discrete layers.
- **`features.ts`** — normalizes a slicer's own feature label into one of
  17 fixed categories; `travel` always wins regardless of label, no
  label at all is `"unknown-extrusion"`, a real but unrecognized label is
  `"custom"` — deliberately different states.
- **`statistics.ts`** / **`timing.ts`** / **`geometry.ts`** — pure
  aggregation over the segments `analyze.ts` already produced. Time
  estimates are two explicitly separate, labelled sources: the file's own
  slicer-provided estimate (parsed from comments, `null` when absent) and
  MeshKit's own `"feed-rate-only estimate"` (path distance ÷ commanded
  feed rate — never modeling acceleration, jerk, pressure advance or
  firmware queues). `geometry.ts` packs typed-array render buffers
  chunked at a configurable ceiling, with precomputed per-layer segment
  RANGES so layer filtering never duplicates the position buffer.
- **`playback.ts`** — a pure state machine (`idle`/`playing`/`paused`/
  `complete`), independently tested without Three.js; the renderer just
  reads `currentMoveIndex` as a draw-range boundary.
- **`analyze.ts`** — the orchestrator; `status` is one of `ready` /
  `ready-with-warnings` / `partial` / `unsupported` / `cancelled` /
  `failed`. An unsupported motion command (e.g. `G5`) is counted and
  disclosed, never faked as a straight line, and parsing continues.

### Rendering (shared `_client.ts`, `src/pages/gcode-viewer/_client.ts`)

Reuses `ToolViewport`/`OrbitControls` exactly as every other tool does.
Whenever a visibility toggle, color mode, or layer selection changes,
the client does ONE pass over the worker's already-in-memory typed
arrays to build a FILTERED position+color buffer and calls
`setDrawRange` — **never one Three.js object per G-code move**, and
never a rebuild per frame. Six color modes: feature, movement type,
tool, layer (a gradient), feed rate (a gradient), and temperature (a
gradient, added in this phase's closeout — see "Phase 9 closeout"
below). Temperature mode is hidden from the color-mode selector
whenever a file declares zero valid nozzle setpoints (`temperatureColor`/
`isTemperatureModeAvailable`, `src/lib/gcode/color-scale.ts`), never
shows bed temperature as if it were nozzle temperature, and colors an
unknown-temperature segment neutral gray rather than a false color.

### Worker protocol (a disclosed architectural decision)

This project's shared worker protocol (`WorkerRequest`) delivers a file
as one already-materialized `ArrayBuffer` — every existing tool reads a
`File` into an `ArrayBuffer` on the main thread first and transfers it
whole; there is no File/Blob-over-postMessage mechanism, and changing
that would touch shared infrastructure every other tool depends on. So
`gcode.worker.ts` doesn't do a true `File.slice()`-level incremental
read — instead, it slices the already-received buffer into small (256KB)
pieces and feeds them through `analyzeGCode()`'s own chunk iterator,
which uses `chunked-lines.ts`'s bounded streaming decoder. That keeps the
actual risk the streaming requirement guards against — decoding the
WHOLE file into one giant string, or splitting it into one unbounded
array of line strings — from ever happening, even though the raw bytes
still arrive as a single buffer per this project's own standing
file-intake convention.

### Route strategy

All five listed intents (viewer / visualizer / simulator / layer viewer /
toolpath viewer) shipped as distinct pages with genuinely different
default UI emphasis and copy — the primary route's general statistics,
the visualizer's five color modes, the simulator's playback-first layout,
the layer viewer's single/cumulative/all-layers controls, and the
toolpath viewer's extrusion/travel/feed-rate breakdown. No route was
omitted or canonicalized this phase.

### Safety ceilings

`AnalyzeLimits` bounds file bytes, decoded lines, line length, comment
length, unsupported-command samples; `ArcSafetyLimits` bounds chord error
and per-arc subdivisions; `RenderBufferLimits` bounds segments per GPU
chunk and total segments before `sourceLineIndices` tracking is dropped
to save memory. A ceiling hit is reported as `status: "partial"` with a
`stoppedReason` — never a false successful visualization.

### Privacy

Identical guarantee to every other tool: no server-side file-processing
route exists, the file is read with the standard File API, parsed in a
Web Worker, and rendered with WebGL — all on-device. No WebSerial, no
printer connection, no network request containing the file or any value
found inside it. Verified this phase via live network-request
inspection during browser testing.

## Known limitations (Phase 9)

- **Supported dialect scope is a documented subset**, not universal
  G-code support — aimed at common FDM output for Marlin- and
  Klipper-style printers from Cura, PrusaSlicer, OrcaSlicer and Bambu
  Studio. Comment-adapter patterns are representative, not exhaustive;
  an unmatched comment is ignored, never guessed at.
- **Filament mass is never calculated** — only raw extrusion distance/
  units, since mass would require a verified filament diameter and
  density this tool doesn't have. A volumetric (`M200`) E value is
  disclosed as such and never reported as a millimeter length.
- **G92 with no axis arguments is a documented no-op** — it does not
  invent an all-axis reset, since real-firmware behavior for a bare
  `G92` is not itself universally consistent.
- **Playback's frame-to-move-count mapping is a simple fixed multiplier**
  (60 moves/sec × playback rate), not adaptive to actual move complexity
  or GPU frame budget — sufficient for a first version, not a claim of
  perceptually-uniform playback speed across wildly different files.

## Phase 9 completion summary

`src/lib/gcode/` (20 modules) plus `src/workers/gcode.worker.ts`, 6
shared Astro components (`GCode{ModelInfo,LayerControls,
PlaybackControls,DisplayControls,Statistics,Warnings}.astro`), and 5
route pages sharing one client orchestrator are now `"ready"` in the
tool registry. A genuine TDD-discovery bug was caught and fixed during
browser verification (not by the unit suite): `GCodeStatistics`'s
`linearMoveCount` was derived as `generatedSegments - arcLineCount`,
which silently produced a wrong, inflated number whenever an arc
expanded into more than one render segment (the overwhelmingly common
case for any real curve) — fixed by tracking the real G0/G1 LINE count
directly, with a dedicated regression test added at both the unit
(`statistics.test.ts`) and integration (`analyze.test.ts`) level. The
R-form arc sign convention was also caught and fixed by its own unit
tests before merge (see "arcs.ts" above). All tests pass, `astro check`
is clean, and the production build emits all 28 routes with zero
non-domain SEO regressions.

## Phase 9 closeout

A focused, strict-TDD closeout pass (same branch, no rewrite) completed
the acceptance criteria this phase's own initial build left open:

- **Temperature color mode shipped** — see "Rendering" above and
  `src/lib/gcode/color-scale.ts`. Nozzle temperature (never bed
  temperature) now propagates from `M104`/`M109` through
  `linear-moves.ts`/`arcs.ts` into a bounded, transferable `Float32Array`
  render attribute (`RenderChunk.temperatures`, NaN-sentinel for
  "unknown," the same convention `feedRates` already used).
- **`"mixed"` layer-detection mode is now real and reachable**
  (`src/lib/gcode/layers.ts`) — genuine extrusion before a file's first
  explicit marker or after its last one is inferred exactly the way a
  marker-free file would be (same Z-hop immunity, same non-planar/vase
  detection) and stitched onto the explicit layers, sequentially
  renumbered by file position. A purely explicit file keeps every
  marker's own declared index untouched — renumbering only ever applies
  once regions are actually combined. Non-planar un-marked territory
  contributes no fabricated layers, with a disclosure note. A
  conflicting/out-of-order explicit marker index is always trusted as
  declared, never silently corrected.
- **A genuine, severe defect was found and fixed while verifying
  cancellation on a large file** — `ChunkedLineDecoder.extractLines()`
  (`src/lib/gcode/chunked-lines.ts`) reassigned `pending = pending.slice(idx
  + 1)` once per extracted line. Against a `TextDecoder`-sourced string
  that chains into a deeply nested run of slices-of-slices touched by
  `tokenizeLine` on every line, this degraded to roughly
  O(linesPerChunk²): a 50,000-line file that should parse in ~100ms took
  over 68 seconds, and a 2,000,000-line file effectively never finished.
  The same function had a second, independent correctness bug: its
  "line too long" check compared the ENTIRE remaining pending buffer's
  length to `maxLineLength`, not the distance to the next newline — so
  any chunk containing many complete short lines (any real file once
  `WORKER_CHUNK_BYTES`, 256KB, comfortably exceeds `maxLineLength`,
  20,000) was spuriously truncated mid-file, silently corrupting output
  and manufacturing false "malformed line" warnings on ordinary files.
  Both are fixed by a single-cursor rewrite (one slice per extracted
  line from a fixed, unchanging string, one final trim per chunk) plus
  force-flattening each extracted line. Regression tests for both the
  correctness case and the performance case live in
  `chunked-lines.test.ts`. Post-fix: 200,000 lines in ~370ms,
  2,000,000 lines in ~12s (linear, not quadratic) — the tool's actual
  real-world file-size ceiling was this bug, not any documented safety
  limit.
- **Full browser-verification matrix completed** across all five routes:
  live playback (play/pause/resume/restart/progress-seek/layer-seek/
  step/rate-change/end-of-file/toolhead-position/file-replacement/reset/
  page-teardown), cancellation and recovery on a real multi-second file,
  every display mode (including temperature's availability-gating and
  legend), 375px responsive layout and keyboard/focus accessibility,
  screenshot export (full/single-layer/paused-playback) and JSON report
  content (privacy-safe: no raw G-code, no local paths, no stack
  traces), and printer-control absence (`navigator.serial`, `WebSerial`,
  `WebUSB`, `OctoPrint`, `Moonraker`, WebSocket — none called anywhere,
  confirmed by source grep). All temporary browser-verification
  fixtures were generated to a local, gitignored scratch directory and
  deleted after verification — none were committed or left in `public/`.
- A second, independent position-readout bug was also caught and fixed
  incidentally while wiring the new toolhead marker:
  `updatePlaybackUi()` was reading a segment's START coordinates as the
  "current position" instead of its END coordinates.

## Pro Feature Set (Phase 10)

The first phase to build anything Pro-facing. Two new module trees,
strictly test-first: `src/lib/pro/` (entitlement — 7 modules, 68 tests)
and `src/lib/batch/` (batch processing infrastructure — 14 modules,
~250 tests). Full details of what each module does are in its own doc
comment; this section covers the cross-cutting architecture.

### Entitlement (`src/lib/pro/`)

`EntitlementSnapshot { status, capabilities, source, checkedAt }` is the
one shape everything reads. `status` is `"free" | "pro" | "unknown" |
"invalid" | "expired" | "unavailable"`; `createSnapshot()` is the single
choke point that forces `capabilities` to an EMPTY, runtime-immutable
`ReadonlySet<ProCapability>` for every status except `"pro"` — fail-
closed is structural here, not something every call site has to
remember. `hasCapability(snapshot, capability)` (`feature-gate.ts`) is
the one function every capability check funnels through; a missing
snapshot, a non-`"pro"` status, or a capability absent from the
snapshot's own set all deny, uniformly.

`EntitlementProvider` is swappable: `production-provider.ts` always
resolves `"free"` with zero capabilities — no query string, no
`localStorage`, no global, nothing read at all (enforced by both a
runtime test and a source-text test that strips comments before
scanning, so the doc comment explaining what's forbidden can't trip its
own check). `test-provider.ts` is the injectable non-production
provider tests use, and must never be reachable from a production code
path — `production-isolation.test.ts` proves this by grepping every
`_client.ts` under `src/pages/` for the string, and a real production
`npm run build` is separately grepped (see "Release gate" below) since
source-level absence doesn't by itself prove bundler dead-code
elimination actually removed it.

`EntitlementStore` wraps whichever provider is active and is what UI
code (`FeatureGate`) actually holds; it fails closed itself (an
unconfigured store returns the same `"unavailable"`/zero-capability
snapshot). `entitlement-provider.ts`'s `createEntitlementProvider()`
factory gives every concrete provider the same generation-counter
staleness guard `WorkerClient` already uses per-request — an async
resolution that's since been superseded is silently ignored, never
applied out of order.

### Batch infrastructure (`src/lib/batch/`)

One shared job model (`BatchJob`, `types.ts`) and `BatchQueue`
(`queue-state.ts`) drive every batch operation. States: `queued →
validating → processing → verifying → succeeded | failed | cancelled`
— a `transition()` call outside this graph is refused (returns `false`,
never throws). `retry()`/`cancel()` bump a per-job
`cancellationGeneration`; `reportProgress`/`reportSuccess`/
`reportFailure` silently no-op when tagged with a stale generation —
the exact per-request pattern `WorkerClient` uses, applied per-job.
`queuedSequence` (not array position) is the FIFO ordering key, so a
retried job goes to the BACK of the line behind jobs already waiting,
never jumping the queue.

`BatchScheduler` dispatches queued jobs through a `JobRunner`, bounded
by concurrency (default 1, hard-capped at 2 — never inferred from
`navigator.hardwareConcurrency`, which says nothing about free memory)
and an optional `MemoryBudget`. Capacity is read from the QUEUE's own
active-job count, never a separate bookkeeping map — a cancelled job
frees its slot the instant `queue.cancel()` transitions it, even before
its worker has actually stopped. A `pump()` reentrancy guard
(`isPumping`) exists because `dispatch()`'s own `queue.transition()`
call synchronously notifies the scheduler's subscription — without the
guard, that reentrant call dispatched jobs out of FIFO order (a real
bug caught by `scheduler.test.ts`, not by inspection).

`MemoryBudget` (`memory-budget.ts`) is a deterministic ESTIMATE, never a
claim of exact browser memory — `OPERATION_MEMORY_MULTIPLIERS` apply a
conservative, operation-specific expansion factor to input bytes (a
repair/optimize job's in-memory footprint is estimated at 6x its
source size; a lighter conversion less). A job that doesn't fit is
skipped (left queued), never started optimistically and never crashes
the tab — the scheduler keeps scanning past it for a smaller job that
does fit, so one heavy file never starves everything behind it.

`adapter-registry.ts` is the one exhaustive map of all 8 operations
(`convert-{3mf,obj,glb,ply}-to-stl`, `convert-stl-to-{obj,3mf}`,
`repair-stl`, `optimize-stl`) to the EXACT worker file and library a
single-file page already uses — no parser or algorithm is duplicated.
`worker-job-runner.ts` is the one shared `JobRunner` every adapter
configures (never reimplements): a fresh `WorkerClient`/`Worker` per
job, `isCancelled()` checked on every progress tick (calling
`client.cancel()` if it flips true), and a per-operation `unwrapResult`
translating that operation's own result envelope into `{ resultMeta,
outputBytes }`. Repair and Optimize's `unwrapResult` functions are
deliberately NOT a simple `outputBytes !== null` check — Optimize's
`"verification-failed"`/`"verification-incomplete"` outcomes can carry
non-null `outputBytes` (the file WAS serialized and reparsed, then
failed a quality-policy threshold), so the outcome itself is checked
explicitly; a verification-failed result is never mistaken for a
successful batch job just because bytes exist.

Result ownership: `ResultStore` owns every object URL created for a
job's downloadable output (via an injected `ObjectUrlFactory`, since
`URL.createObjectURL` isn't available in this project's Node test
environment) and revokes on job removal, `clearCompleted()`, a ZIP
finishing/failing, or disposal — never left to the browser's own
garbage collection. `filenames.ts`'s `FilenameCollisionTracker`
resolves the documented `"part.stl"`, `"part (2).stl"`, `"part
(3).stl"` suffix scheme, case-insensitively, and is used defensively
inside `zip-download.ts` even though the caller is expected to have
already resolved unique names — a real bug (recomputing/re-reserving a
job's output filename on every re-render, not just once, from a
`batch-workspace-client.ts` UI bug caught during live browser
verification) is why this defense-in-depth exists.

`zip-download.ts` uses `fflate` directly (never
`threemf/package-writer.ts`, which writes 3MF's specific fixed 3-entry
OPC layout) — `outputs/`, `reports/` (every job, succeeded or not —
never a fake output file for a failed/cancelled one), and a top-level
`batch-summary.json`, each bounded by its own ceiling (file count,
total uncompressed bytes, per-file bytes, filename length, report
bytes). `presets.ts` persists STL Repair/Optimization presets under a
namespaced, versioned `localStorage` key
(`meshkit.pro.presets.v1.<operationKind>`) — never entitlement state or
file bytes; every write is refused when `canUsePresets()` is false, but
reading an already-saved preset is never gated, so a preset doesn't
appear to vanish. A storage schema version newer than this build
understands is treated as unreadable and left completely untouched,
never deleted or guessed at.

### UI integration and lazy loading

A `BatchWorkspace.astro` component (Single file/Batch tabs, drop zone,
file list, ZIP/report download buttons) is embedded ALONGSIDE each
batch-capable page's existing single-file UI — never replacing it. The
client wiring is split into two modules specifically so a Free user's
page load never fetches the heavy batch engine:
`batch-entitlement-gate.ts` (tiny — entitlement/capability logic only)
is the only module every page's `_client.ts` imports statically; it
dynamically `import()`s `batch-workspace-client.ts` (the whole
`src/lib/batch/` tree plus `fflate`) ONLY once its own capability check
has already confirmed Pro. Verified two ways: a production `npm run
build` shows `batch-workspace-client` as its own separate emitted chunk
(only referenced, never inlined, from the shared page bundle), and
`astro preview`-serving that build while clicking into the Batch tab as
a Free user shows ZERO network requests for it.

All 8 batch-capable operations are wired into their existing
single-file pages this way. The 6 conversion operations
(3MF/OBJ/GLB/PLY→STL, STL→OBJ, STL→3MF) use `BatchWorkspace.astro` /
`batch-workspace-client.ts`'s immediate-run shape — batch processing
genuinely works end-to-end (verified live: multi-file intake, real
worker dispatch, per-file progress/retry/cancel/remove, individual and
ZIP download, batch JSON report, file-type rejection, focus restored
correctly after every row re-render). STL Repair and STL Optimization
use a second, generic shape — `BatchPlanWorkspace.astro` /
`batch-plan-workspace-client.ts`'s `PlanWorkflow`-backed three-stage
flow (file intake → analyze/plan each file → aggregate plan review →
confirm and run) — since a repair/optimization batch job must never
mutate a file the instant it's added, matching each operation's own
single-file page's "see a plan before mutation" guarantee. Both shapes
share the same queue/scheduler/adapter-registry/ZIP/report/preset
infrastructure underneath; see "Phase 10 closeout" below for the
repair/optimize wiring's own verification record.

### Production-lock policy, verified

Until Phase 11 (Dodo Payments, license issuance), the production
provider always resolves Free — no bypass exists, source-level or
build-level (see "Entitlement" above). Live browser verification
against BOTH `astro dev` and a real `astro preview` (production build)
confirmed: the locked notice ("Pro batch tools are being prepared.
Purchasing is not available yet." — no Buy/Upgrade/Activate/Restore
button anywhere) is what a Free user genuinely sees; the existing
single-file workflow on every touched page is provably unchanged (a
plain OBJ→STL conversion was re-run and still worked identically).
Entitlement is always an explicit constructor dependency, never
resolved internally by a page's own code: every production `_client.ts`
instantiates only `createProductionEntitlementProvider()` and passes it
into `initBatchEntitlementGate()`/`initBatchRepairPlanClient()`/
`initBatchOptimizePlanClient()`; a test or live-verification harness
instead constructs `createTestEntitlementProvider({status, capabilities})`
and passes THAT in — no runtime branch anywhere chooses between them,
and no URL query string, URL fragment, `localStorage`, `sessionStorage`
or global variable can affect entitlement (an earlier `?devPro=1`
dev-only query-flag mechanism existed during this phase's initial build
and has since been REMOVED entirely, replaced by this dependency-
injection pattern — see "Phase 10 closeout" below). Both the absence of
any such mechanism and the absence of the test provider itself from
production bundles are verified by source-level scans
(`production-isolation.test.ts`, `batch-entitlement-gate.test.ts`) and
a built-`dist/` grep (see "Release gate").

## Phase 10 initial-build limitations (historical — resolved in "Phase 10 closeout" below)

At the end of Phase 10's initial build (before the closeout pass), the
following were open: STL Repair/Optimization batch UI wiring, live
verification of the 4 converter pages beyond `/obj-to-stl/` and
`/stl-to-obj/`, a live in-flight cancellation reproduction, a 375px
mobile screenshot pass for the batch UI, and UI exposure of the
scheduler's `concurrency` option. Every one of these was closed out in
the pass described below.

## Phase 10 closeout

A focused, strict-TDD closeout pass (same branch, no rewrite) completed
every item the initial build left open:

- **The `?devPro=1` dev-only URL-unlock mechanism was removed
  entirely** and replaced with explicit constructor dependency
  injection for entitlement — see "Production-lock policy, verified"
  above. `initBatchEntitlementGate()`, and the new
  `initBatchPlanEntitlementGate()` it shares its shape with, both now
  REQUIRE an `EntitlementProvider` parameter; there is no internal
  construction logic left to remove a flag from. Failing-first tests
  (`batch-entitlement-gate.test.ts`, extended
  `production-isolation.test.ts`) prove query params, URL fragments,
  `localStorage`, `sessionStorage` and globals can't affect entitlement,
  and that no production entry point imports the test provider.
- **STL Repair and STL Optimization batch UI is now fully wired**, on
  `/stl-repair/`, `/make-stl-watertight/`, `/repair-non-manifold-stl/`
  (repair) and `/reduce-stl-file-size/`, `/simplify-stl/`,
  `/stl-triangle-reducer/` (optimization) — all six share their
  canonical page's `_client.ts` wiring exactly like the converter
  secondary-SEO routes already did. New shared infrastructure: a
  generic `PlanWorkflow<TSettings, TPlan>` state machine
  (`src/lib/batch/plan-workflow.ts` — pending → planning → planned/
  failed → stale, settings changes invalidate every planned/failed
  entry, confirmation requires every entry in a terminal state), a
  generic `BatchPlanWorkspace.astro` + `batch-plan-workspace-client.ts`
  engine parameterized by each operation's own plan function and
  summary renderer, `repair-plan.ts`/`optimize-plan.ts` (the exact same
  `analyzeSTLDiagnostics()`/`planRepair()`/`planOptimize()` calls each
  single-file page already uses, run directly rather than through a
  Worker for the plan step, and now converting their own thrown
  exceptions to a `SafeError` via `toSTLRepairSafeError()`/
  `toSTLOptimizeSafeError()` instead of leaking a generic message — see
  the plan-workflow bug below). Batch repair and batch optimization
  integration tests (`batch-repair-integration.test.ts`,
  `batch-optimize-integration.test.ts`) exercise the REAL adapter
  end-to-end (parse → diagnose → repair/optimize → serialize → reparse →
  re-diagnose) against a mixed batch of repairable, already-valid,
  unresolved-non-manifold and invalid fixtures.
- **A genuine UI bug was found and fixed while live-verifying planning
  on a large file**: the plan-review screen never subscribed to
  `PlanWorkflow`'s own `notify()` calls, so a multi-second (or, for a
  320k-triangle stress file, 20+ second) analysis showed a static
  "Pending." with zero feedback the entire time — indistinguishable
  from a hang — only updating once the WHOLE batch's `planAll()`
  settled. Fixed by `workflow.subscribe(renderPlan)` in
  `batch-plan-workspace-client.ts`, so "Analyzing…" now renders live
  per file as `PlanWorkflow` transitions it. A second bug found in the
  same pass: a planning failure (e.g. hitting the diagnostics analysis
  time budget) was always collapsed into a generic "Something went
  wrong" — `PlanWorkflow.planAll()`'s catch block now preserves an
  already-`SafeError` rejection via `isSafeError()` instead of always
  minting a fresh `UNKNOWN_ERROR`, and `planRepairFile`/
  `planOptimizeFile` now convert their own thrown exceptions before
  rejecting. Regression tests for both live in `plan-workflow.test.ts`
  (SafeError preservation vs. fallback) and
  `repair-plan.test.ts`/`optimize-plan.test.ts` (invalid-STL rejects
  with an already-safe error, never a raw parser exception).
- **All 6 converter pages verified live**, not just `/obj-to-stl/` and
  `/stl-to-obj/` — `/3mf-to-stl/`, `/glb-to-stl/`, `/ply-to-stl/` and
  `/stl-to-3mf/` were each driven through a real mixed valid/invalid
  batch (hand-built, spec-valid fixture bytes for each format) with the
  explicit-injection harness: locked→unlocked capability check, real
  per-format parsing, error isolation (one invalid file never blocks
  the others), individual download reparsed by the production parser,
  and a ZIP download inspected for correct `outputs/`/`reports/`/
  `batch-summary.json` structure.
- **Preset management UI completed** — `preset-manager-ui.ts` (shared
  by repair and optimize) wires "Manage presets" to a panel supporting
  rename (with duplicate-name rejection), delete (with confirmation),
  export (a downloaded JSON file) and import (a corrupted-file error
  distinct from a valid-but-partially-duplicate import's "N imported, M
  skipped" count) — all live-verified, on top of the `PresetStore`
  class's own pre-existing unit test coverage for every one of those
  cases at the storage level.
- **Concurrency is now exposed in the UI and independently
  controllable at runtime.** `BatchScheduler` gained
  `getConfiguredConcurrency()`, `getEffectiveConcurrency()` (how many
  jobs are ACTUALLY running right now, which can be lower than
  configured when a `MemoryBudget` won't admit a second file) and
  `setConcurrency()` (rejects anything but the integers 1 or 2; lowering
  it while jobs are active never cancels them, it only withholds new
  dispatches until the active count drops below the new limit — raising
  it dispatches an already-queued eligible job immediately). A "Files
  processed at once" radio control and live status line
  (`batch-workspace-client.ts` and `batch-plan-workspace-client.ts`)
  expose both numbers. 8 new tests in `scheduler.test.ts` cover
  rejection of invalid/above-cap values, idle and active switching in
  both directions, and the memory-budget-reduces-effective-concurrency
  case.
- **Genuine in-flight cancellation reproduced live** across conversion,
  repair-planning, repair-execution and optimization, using real files
  large enough to stay in a non-terminal state (a 500k-triangle/18MB
  grid mesh for conversion, a 320k-triangle/16MB grid STL for repair) —
  caught reliably via a `MutationObserver` on the row/plan-row state
  text rather than timing guesses. Confirmed each time: the cancelled
  file has no downloadable output, its eventual (sometimes much later)
  worker completion is ignored rather than resurrecting it as
  succeeded, a freed slot immediately picks up the next queued file,
  retry works, and a subsequent batch on the same workspace instance
  behaves normally. ZIP-generation cancellation was evaluated and found
  not applicable to this codebase's implementation — `buildBatchZip()`
  is synchronous and atomic (it either returns a complete archive or
  throws before any `URL.createObjectURL`/download ever happens), so
  there is no partial-archive state to clean up.
- **375px mobile/accessibility screenshots captured** for the converter
  batch workspace, the repair plan screen, repair results, the
  optimization plan screen and optimization results — no horizontal
  overflow anywhere, and a real layout defect was found and fixed:
  `BatchPlanWorkspace.astro`'s per-file plan `<dl>` (Detected issues /
  Planned operations / Skipped operations / …) kept its label and value
  side-by-side even at narrow widths, so a long, multi-word `<dt>` (e.g.
  "Skipped operations") wrapped onto a second line that visually
  collided with the `<dd>`'s own first line. Fixed with a `flex-
  direction: column` rule at the existing 480px breakpoint, stacking
  label above value like every other mobile card layout on the site
  already does.
- **Entitlement revocation policy verified live**, not just
  documented: revoking mid-batch (one file running, one queued) leaves
  the running file to finish (its output stays downloadable even while
  the UI is showing the locked notice, since only the DOM display
  toggles — the underlying queue/scheduler instance is never torn
  down), never starts the queued file, and restoring entitlement
  resumes it immediately without needing a page reload.
- **Production isolation re-verified against a build containing all of
  this closeout's new code** — `dist/` grepped clean for `devPro`, the
  test-provider, and every Dodo/checkout/license term; the batch-plan
  workspace engine confirmed as its own separate emitted chunk, never
  fetched by a Free/locked `astro preview` session on any of the 8
  operations or the homepage; every structured-data `Offer` still
  prices at `"0"`.

**What remains genuinely unresolved after this closeout** (unchanged
from before — these were never in scope for Phase 10): Pro purchase
activation itself, Dodo Payments integration, license issuance and
validation, cross-device preset sync, and account recovery — all belong
to Phase 11 (see below). Presets remain device-local `localStorage`
only, by design, until Phase 11 has an account concept to sync them
against.

## Phase 10 hotfix — conversion batch report safety and ZIP reliability

A narrowly-scoped, strict-TDD corrective pass fixing a defect the
launch-readiness audit (a separate verification pass, not part of this
closeout) found in the conversion family specifically — repair and
optimize were verified unaffected before any code changed.

**The defect**: `adapter-registry.ts`'s `unwrapConversionResult()` used
to build `resultMeta` by spreading a conversion worker's ENTIRE raw
result object (minus only its named output-buffer key) — and every
conversion worker's result also carries the full parsed source-mesh
`positions`/`normals` typed arrays it returns for the single-file
3D-viewport preview. Those arrays leaked verbatim into every
downloadable batch JSON report and the ZIP's `batch-summary.json`/
per-file `reports/*.json` entries: a genuine privacy/design violation
(raw geometry inside what should be bounded metadata) that also crashed
with an uncaught `RangeError: Invalid string length` for large enough
source files, breaking both "Download batch report (JSON)" and
"Download all as ZIP" outright.

**The fix**, `src/lib/batch/conversion-result-meta.ts` +
`src/lib/batch/result-meta-guard.ts`:

- **Explicit per-format projection** (never a spread): six
  `project*Meta()` functions, one per conversion operation, each
  picking ONLY the small, JSON-safe, genuinely useful summary fields a
  real worker result contains (triangle/vertex counts, bounds, format
  labels, warnings) — a field not named in a projector can never reach
  a batch report, no matter what a worker's result object happens to
  contain. `CONVERSION_RESULT_META_ALLOWED_KEYS` restates each
  projector's own output keys as a `Set` for the guard below.
  `adapter-registry.ts`'s `unwrapConversionResult()` now takes the
  matching projector as an explicit parameter instead of doing its own
  spread; repair's and optimize's own `unwrapRepairResult()`/
  `unwrapOptimizeResult()` are untouched — their result shapes were
  already bounded diagnostic summaries, never per-vertex arrays.
- **Defense-in-depth guard**, applied uniformly to every operation's
  `resultMeta` right before it enters a report (`report.ts`'s
  `buildDownloadableBatchReport`, and both `batch-workspace-client.ts`'s
  and `batch-plan-workspace-client.ts`'s per-file ZIP report
  construction): rejects binary buffers/typed arrays/`Blob`/`File`,
  circular references, excessive nesting/string/array length, non-finite
  numbers, `BigInt`, and (for the six conversion operations specifically)
  any key outside that operation's own allowlist — never throws, instead
  swaps the offending file's `resultMeta` for a tiny, fixed-shape,
  genuinely safe placeholder, so one file's unexpected metadata degrades
  gracefully rather than crashing an entire batch's report/ZIP download.

**Verified**: 70 new tests (`conversion-result-meta.test.ts`,
`result-meta-guard.test.ts`, extended `adapter-registry.test.ts` and
`report.test.ts`, and a new `batch-conversion-integration.test.ts`
running the REAL adapter pipeline for all six conversion operations —
succeeds, individual output reparses with the production parser, report
has useful metadata and zero raw geometry, ZIP contains the right
`outputs/`/`reports/`/`batch-summary.json` entries, invalid jobs stay
isolated, only successful jobs appear in `outputs/`, and a 125,000-
triangle fixture proves the report/ZIP stay small and bounded
regardless of source complexity). Live-reproduced and confirmed fixed
in a real browser for the exact original crash (a 500×500-vertex/18MB
OBJ, "Download batch report (JSON)" and "Download all as ZIP" both now
succeed with zero uncaught errors, report shrinks from what would have
been tens of megabytes to under 2KB) and independently for
`convert-stl-to-obj` (a different buffer key/projector shape).
Concurrency 2, genuine in-flight cancellation, retry and mixed valid/
invalid isolation were all re-verified live post-fix and remain
unaffected. Repair's and optimize's own reports were re-verified live
to still carry their full diagnostic content (`boundaryEdgeCount`,
`outcome`, `deviation`, `surfaceAreaBefore/After`, `volumeBefore/After`)
completely unchanged. Actual conversion output bytes, filenames and
download formats are untouched by this hotfix — only report/ZIP
*metadata* construction changed.

Nothing was committed, pushed, published, deployed, or charged as part
of this hotfix.

## Phase 10 handoff: Pro Feature Set (original plan, now closed out — kept for the historical record)

Recommended starting point, in order:

1. This is the first phase to build anything Pro-facing at all. Every
   prior phase (through Phase 9) intentionally shipped Free-tier tooling
   only — Pro is currently 0% implemented, a pure homepage/copy promise
   with no backing code, payment flow, or licensing mechanism.
2. Resolve the payment/licensing architecture decision FIRST (flagged as
   unresolved in `docs/PRODUCT-READINESS-AUDIT.md` since that audit's own
   original pass) — this almost certainly requires a real backend/
   payment-processor decision, which breaks this project's own
   established "100% local, no server" architecture for the Free tier.
   Document explicitly which parts of Pro (if any) can remain
   client-side (e.g., a locally-verified license key) vs. which
   genuinely require a server (payment processing, license issuance,
   account state) — do not silently introduce a server-side dependency
   into a page that also serves the Free tier without disclosing it.
3. Batch processing (multiple files processed in one session) is the
   most-referenced Pro feature across this project's own UI copy
   ("Optimizing many files? Batch processing is planned for Pro.",
   similar notes on STL Repair and STL Optimize) — decide whether Pro's
   first real feature is batch processing, or something else, and update
   every one of those forward-referencing UI strings to match reality
   once a real Pro feature ships (they currently describe a plan, not a
   built feature — same staleness-guard discipline Phase 7 established
   for the homepage should apply here too).
4. Whatever ships must still respect every existing safety/privacy
   guarantee this project has built phase over phase — a Pro tier that
   silently uploads a user's file to enable a server-side feature is a
   direct contradiction of every "processed locally" claim on every
   existing page, and must never happen without an extremely explicit,
   separate, opt-in disclosure specific to that one feature.
5. Do not retrofit Pro requirements into Free-tier code paths students
   already depend on (Phase 1 through Phase 9's own worker/client/report
   patterns) — Pro should be additive, following the same reuse-over-
   reinvention discipline every phase since Phase 5 has used.
6. **Explicit Phase 10 scope boundary**: Phase 10 builds real Pro
   capabilities, starting with shared batch infrastructure and batch
   conversion/repair/optimization. Phase 10 may introduce an entitlement
   interface and a production-disabled gate for testing that interface.
   Phase 10 must NOT implement checkout, Dodo Payments integration,
   license issuance, or production license validation — those belong to
   Phase 11. Every existing Free-tier single-file workflow must remain
   complete and unchanged throughout.

## Phase 11 handoff: Dodo Payments and licensing

Phase 10 is 100% complete, including its closeout pass: the entitlement
interface (`src/lib/pro/`) and batch infrastructure (`src/lib/batch/`)
are built, strictly test-first, with the production provider verified
(source- and build-level) to always resolve Free. All 8 batch-capable
operations — the 6 conversions plus STL Repair and STL Optimization —
are live-wired into their pages with full plan/preset/concurrency UI;
see "Phase 10 closeout" above for the complete verification record. Pro
capabilities are implemented; Pro purchase activation remains
unavailable, and payments/licensing remain 0% implemented — that is
entirely Phase 11's own scope, described below.

Phase 11 builds the real payment/licensing layer Phase 10 deliberately
left unbuilt:

1. Resolve the payment/licensing architecture decision — Dodo Payments
   integration, checkout flow, license issuance, and production license
   validation. This will very likely require a real backend, which is a
   genuine departure from this project's "100% local, no server"
   Free-tier architecture; document explicitly and precisely which
   parts of Pro activation are client-side (e.g. a locally-verified
   license key, cached entitlement) versus server-side (payment
   processing, license issuance, account state) — never introduce an
   undisclosed server dependency on a page that also serves Free users.
2. Replace `src/lib/pro/production-provider.ts`'s always-Free resolution
   with a real check against issued licenses — keep its EXACT shape
   (`EntitlementProvider`, fail-closed via `createSnapshot()`) so
   `entitlement-store.ts`/`feature-gate.ts`/every batch page's
   `batch-entitlement-gate.ts`/`batch-plan-entitlement-gate.ts` need no
   changes; only how the snapshot is *resolved* changes.
3. Every existing Free-tier guarantee (this project's own "100% local,
   processed on this device" claim on every page) must survive Phase 11
   completely intact for every Free-tier workflow — a real payment flow
   is additive, never a reason to compromise a promise already made on
   18+ existing pages.
4. Do not begin building anything beyond Phase 11's own scope (no new
   Pro capabilities beyond activating what Phase 10 already built —
   batch processing, plan/preset/concurrency UI and revocation handling
   are all already done and must not be re-scoped here).
5. Design an account/device concept if cross-device preset sync is
   wanted — presets are currently `localStorage`-only by design (no
   Phase 10 infrastructure exists to sync them, since there was no
   account concept to sync against).

- The ASCII STL parser (`parse-ascii.ts`) tokenizes the whole file into
  one JS array up front and accumulates positions/normals in plain
  arrays before a final `Float32Array.from()` conversion, rather than
  pre-counting facets and writing directly into a pre-sized typed array.
  Simpler and safe (bounded by the same `maxTriangles`/file-size limits
  as binary), but not the most memory-efficient approach for very large
  ASCII files — binary STL doesn't have this cost since its layout is
  fixed-size per triangle.
- `fitCameraAndControls`'s "Reset camera" and "Fit model" buttons do the
  exact same thing (see "Camera-fitting strategy" above) — there is no
  separate "remember where the user started vs. what best frames the
  current model" distinction, because a single-model viewer only ever
  has one meaningful fit target. This would need to change if a future
  version supported comparing multiple models at once (explicitly out of
  scope for this phase).
- The "Display dimensions as" mm/cm/in conversion assumes the file's raw
  numbers are millimeters. That's a genuinely common convention for
  3D-printing STL files, not a universal one — a model authored in
  meters or inches would convert "correctly" in the arithmetic sense but
  misleadingly in the real-world sense. The UI never claims certainty
  here; "model units" (no conversion, no claim) remains the default.
- Only one route (`/stl-viewer/`) exists; `/online-stl-viewer/` is a
  static-host 301 redirect (`public/_redirects`) rather than a page — see
  "Route strategy" above for why, and what to do on a host that doesn't
  honor that file.

## Known limitations (Phase 3A)

- ZIP entry filenames are always decoded as UTF-8. Legacy ZIP archives
  without the UTF-8 general-purpose flag technically use CP437 (or
  another legacy codepage) for non-ASCII filenames; this project doesn't
  special-case that, so a 3MF package with unusual legacy-encoded
  internal filenames could show mildly mangled diagnostic text (this
  never affects safety — the safety checks operate on raw bytes/lengths
  regardless of how a name decodes, only pretty-printing would be off).
- Central-directory CRC32 values are read but not verified against the
  actual decompressed content. Size checks (declared vs. actual,
  before/after inflate) catch truncation and most corruption; a
  pathological entry with corrupted bytes that happens to decompress to
  the *correct length* but wrong content would not be caught by this
  layer — geometry validation (`THREEMF_VERTEX_INVALID` /
  `THREEMF_TRIANGLE_INVALID` / XML malformed errors) is the real
  backstop for that case in practice, since corrupted mesh XML almost
  never happens to parse as valid, well-formed, in-range geometry.
- Only `<basematerials>`, `<colorgroup>`, `<texture2d>` and `<metadata>`
  produce a visible conversion warning. Other, less common 3MF
  extensions (beam lattices, slice stacks, production/secure-content
  extensions) are silently ignored by the XML tokenizer — geometry still
  converts correctly since these never contain core mesh data, but no
  warning is shown for them specifically. Worth extending
  `UNSUPPORTED_RESOURCE_ELEMENTS` in `model-parser.ts` if real-world
  files surface a need.
- `fflate` (~8 KB) is this project's first npm runtime dependency beyond
  `astro` and `three` — used exclusively for `inflateSync`, isolated to
  `src/lib/threemf/package.ts` and the 3MF worker bundle; it is not
  reachable from the homepage or the STL viewer.

## Known limitations (Phase 3B)

- MeshKit only supports UTF-8 OBJ text. A file saved in a legacy 8-bit
  codepage (Latin-1, Windows-1252, Shift-JIS, etc.) with non-ASCII
  content (e.g. a comment or object name) fails to decode
  (`OBJ_TEXT_DECODE_FAILED`) rather than being guessed at — OBJ has no
  standard encoding declaration, so guessing would risk silently
  mis-reading geometry-adjacent text in some other, wrong encoding.
- The self-intersection check (`hasSelfIntersection()`) is a 2D
  edge-crossing test performed on the polygon's own dominant-plane
  projection. It reliably catches a self-intersecting face, but does not
  attempt to classify or repair *which* sub-region is "really" intended
  — the whole face is rejected, matching this phase's "fail safely
  rather than guess" approach rather than the more involved job a
  dedicated repair tool would eventually do.
- `maxFaceVertexCount` defaults to 256 (smaller than `maxTriangles`'s 3
  million) because ear clipping is worst-case O(n³) in a single face's
  vertex count — a huge n-gon is a cheaper way to construct a
  pathological input than a huge triangle count is. A legitimate OBJ
  face beyond 256 vertices (unusual, but not impossible for some
  CAD-exported files) is rejected by this safety ceiling; the fix is
  raising the limit deliberately once real-world files justify it, not
  removing it.
- Only `materials-not-preserved`, `textures-not-preserved`,
  `smooth-shading-converted`, `groups-merged`,
  `vertex-colors-not-preserved`, `lines-ignored`, `points-ignored` and
  `non-planar-faces` produce a warning. Other OBJ statements this
  converter doesn't specifically track (curve/surface statements,
  `vp`, free-form geometry) are silently ignored rather than warned
  about — they never contribute polygon geometry, so silence here means
  "not applicable," not "detected but unreported."

## Known limitations (Phase 3C)

- `KHR_mesh_quantization` (normalized/integer-encoded position accessors)
  is not implemented — a GLB relying on it for its `POSITION` accessor is
  rejected with `GLB_ACCESSOR_TYPE_UNSUPPORTED` rather than misread as
  plain floats. Worth adding if real-world quantized files surface a need.
- `data:` URIs for buffers are not supported — MeshKit only reads the
  GLB's own embedded BIN chunk; a buffer declaring *any* `uri` (external
  path or embedded `data:` URI alike) is rejected as
  `GLB_EXTERNAL_BUFFER_UNSUPPORTED`. This is a deliberate scope choice
  (the spec explicitly allowed either decision), not an oversight — GLB's
  whole appeal over `.gltf`+external-files is that everything is already
  embedded in one binary container, so this covers the overwhelming
  majority of real-world GLB files.
- `EXT_meshopt_compression` is detected and rejected wherever this
  converter would otherwise read that bufferView, but there's no attempt
  to distinguish "this bufferView is meshopt-compressed" from "some
  other, unrelated bufferView elsewhere in the same file is" in the
  error message shown to the user — both surface the same
  `GLB_MESHOPT_UNSUPPORTED` message.
- Only `materials-not-preserved`, `textures-not-preserved`,
  `vertex-colors-not-preserved`, `animations-not-preserved`,
  `skins-not-preserved`, `morph-targets-not-preserved`,
  `unsupported-primitives-skipped` and `degenerate-triangles-skipped`
  produce a warning. Tangents, cameras and lights are neither converted
  nor specifically warned about (they never contribute triangle
  geometry, so silence here means "not applicable," matching OBJ's same
  policy for statements it doesn't specifically track).

## Known limitations (Phase 3D)

- `formatFloat32()`'s round-trip guarantee is specifically for **float32**
  values (everything the STL parser ever produces, since `positions`/`normals`
  are always `Float32Array`s) — it is not a general-purpose float64
  formatter, and was never tested or tuned as one.
- Exact deduplication means a mesh with genuinely no repeated vertices
  (e.g. one already exported from a tool that doesn't duplicate STL-style)
  produces an OBJ with `uniqueVertexCount === sourceTriangleVertexCount` —
  correct, but offers no size reduction in that case; there is no
  fallback to tolerance-based welding to shrink it further, by design.
- The output-size ceiling (`OBJSerializeLimits.maxOutputBytes`) is
  enforced against an *estimate* (`line.length + 1` per line, summed
  incrementally) rather than the exact final UTF-8 byte count — accurate
  for the ASCII-range content OBJ text always is in practice, but not a
  byte-exact pre-check.

## Known limitations (Phase 3E)

- `writeThreeMFPackage()`'s output-size check happens *after* `zipSync()`
  has already compressed and assembled the whole package in memory —
  there's no incremental, pre-compression estimate the way
  `serializeOBJ()`'s line-by-line byte estimate works for OBJ text (ZIP
  compression ratios aren't predictable enough up front to estimate
  cheaply), so a pathologically large model still pays the full
  compression cost before `THREEMF_OUTPUT_TOO_LARGE` can be reported.
- Byte-for-byte ZIP determinism depends on `fflate` itself producing
  identical compressed bytes for identical input across versions/platforms
  — true today (verified by `package-writer.test.ts`), but not a
  guarantee this project controls directly the way the hand-rolled 3MF
  *reader* controls its own byte-level behavior.
- The millimetre declaration is a fixed, undocumented-per-file policy —
  there's no way for a user who *does* know their STL's real-world scale
  (say, they authored it in inches) to have MeshKit declare that instead;
  every output package says `unit="millimeter"` regardless. A future,
  carefully-scoped enhancement could offer an explicit "I know my file's
  units are X" opt-in, but that's meaningfully different from unit
  *detection* and was left out of this phase's scope deliberately.

## Known limitations (Phase 3F)

- A face with zero measurable area is a hard parse error
  (`PLY_POLYGON_DEGENERATE`), not a silently-skipped triangle — this is a
  deliberate consequence of reusing `triangulatePolygon()` byte-for-byte
  rather than adding PLY-specific leniency, and means a real-world 3D
  scan with even one degenerate face (a common scanning artifact) will
  currently fail to convert rather than convert with that one face
  dropped. A future phase could special-case this for PLY specifically,
  but that would diverge from OBJ's identical-triangulator guarantee this
  phase's instructions explicitly asked for.
- Neither vertex normals nor vertex colors are preserved, and per-vertex
  properties are always narrowed to whatever precision the *output*
  needs (float32 coordinates) regardless of a richer declared source
  type — consistent with every other converter's "STL stores surface
  geometry only" limitation, not unique to PLY.
- The ASCII reader tokenizes the entire remaining file body into one
  in-memory string array up front, rather than streaming row by row —
  consistent with how the OBJ parser holds its whole document in memory,
  but a meaningfully different (larger) footprint than the binary
  readers' fixed-cursor approach for an equivalently large ASCII file.

## Known limitations (Phase 4A)

- "Objects"/"Groups" counts and the scene tree are derived from
  triangle-bearing segments only. An `o`/`g` declaration whose faces never
  materialize (a lines/points-only sub-object, or a declaration followed
  by no faces at all) doesn't get its own scene-tree entry or count toward
  `objectCount`/`groupCount`, even though its line/point geometry still
  renders and is counted separately (`lineCount`/`pointCount`). This keeps
  the displayed numbers internally consistent with the scene tree, at the
  cost of not surfacing a lines-only object's own name anywhere.
- The parse loop's cancellation checks are stage-boundary-only, matching
  `/obj-to-stl/`'s existing behavior — a single extremely large file's
  parse itself can't be interrupted mid-loop, only between the worker's
  reading/decoding/parsing/building stages. This is an existing property
  of OBJ's reader-side pipeline this phase preserved rather than a new gap
  introduced by the viewer.
- An optional "color by object/group" display mode (a deterministic
  internal palette, explicitly not the file's real materials) was
  considered and deferred — Phase 4A ships one neutral, user-selectable
  model color plus per-segment show/hide, not per-segment color.
- The scene tree renders individual checkbox rows for up to 150 segments;
  a file with more objects/groups than that still has every segment fully
  controllable via "Show all"/"Hide all" and the underlying visibility
  state, but segments beyond the render cap don't get their own row —
  consistent with "aggregate or virtualize rather than rendering thousands
  of controls" rather than a hard ceiling on segment count itself (that
  ceiling, `maxSegments`, is set far higher, as a worker-safety backstop).
- `.mtl` material libraries and referenced images are never fetched, by
  design (see "Privacy boundary" above) — this is the deliberate answer to
  the scope question the previous handoff section raised, not an
  oversight. A future, separate, explicitly-scoped feature could offer an
  *opt-in* local `.mtl` file picker (still never a network fetch) if real
  demand for material-accurate preview emerges.

## Known limitations (Phase 4B)

- The scene tree's per-segment `colorResourceRef` label reflects only the
  mesh object's own default `pid`/`pindex` — a segment whose individual
  triangles carry per-triangle color overrides won't show that nuance in
  the label text, even though "Embedded colors" mode renders every
  triangle's actual resolved per-corner color correctly. This is a
  scene-tree summary limitation, not a rendering one.
- Texture2D image parts are detected and counted, never decoded or
  rendered, even though they live inside the same package and would
  require no external fetch to read — this phase's "detect and disclose,
  don't decode" precedent (already established for OBJ's `.mtl`) was kept
  consistent rather than making an exception for 3MF's embedded case.
- A production-extension cross-part reference (`path` attribute on a
  `<component>`/`<item>`) is detected and skipped, never resolved — this
  viewer only ever reads the package's primary model part, consistent
  with "Multiple-file viewing" being out of scope for all of Phase 4, not
  just this phase.
- Thumbnail *presence* (`Metadata/thumbnail.*`) isn't surfaced as its own
  stat — thumbnails are never decoded or displayed either way, so this is
  a minor reporting gap, not a functional one.
- Unknown (non-standard) `<metadata>` keys are extracted individually,
  the same as known ones — they aren't aggregated into a single "N other
  entries" summary distinct from named entries, though the shared
  `maxMetadataEntries`/`maxMetadataBytes` ceilings still bound the total.
- Component-resolution cancellation is stage-boundary-only, matching
  `threemf-to-stl.worker.ts`'s existing behavior — an extremely large
  package's component walk itself can't be interrupted mid-traversal,
  only between the worker's parsing/resolving/building stages. This is an
  existing property of the 3MF reader's pipeline this phase preserved,
  not a new gap introduced by the viewer.
- An optional "color by object/group" display mode ships as "Color by
  object" using a deterministic internal palette (hashed from each
  segment's underlying mesh-object ID) — clearly labeled as a
  visualization aid in the UI copy, never presented as the file's real
  material appearance.

## Known limitations (Phase 4C)

- Only `baseColorTexture` is decoded and rendered. Metallic-roughness,
  normal and occlusion texture maps are detected (`hasUnsupportedTextureMap`)
  and disclosed with a warning, but never decoded — surfaces still render
  correctly using their material factors alone, per this phase's own
  explicit "detect precisely, or implement completely" instruction.
- `KHR_texture_transform` and any `texCoord` set other than 0 disable
  just the affected `baseColorTexture` (falling back to
  `baseColorFactor`) rather than rendering it with incorrect UV
  placement — a deliberate "don't guess" choice, not a bug.
- WebP-sourced images are never decoded, even in a browser that supports
  WebP — this phase implements the two "core MIME types" the spec names
  (PNG, JPEG) and nothing else; a WebP texture is detected and reported
  the same way an unsupported texture map is.
- Tangent presence/count are parsed and shown in model info, but no
  `TANGENT` attribute is ever bound to the Three.js geometry, since
  normal-map rendering isn't implemented this phase — an unused GPU
  attribute would cost memory for no visual benefit, and this is
  explicitly permitted by this phase's own instructions.
- Animation channels, skin deformation and morph targets are detected,
  counted (`animationCount`/`skinCount`/`morphTargetCount`) and disclosed
  with a warning, but never applied — only the file's static default-pose
  scene ever renders, matching how `resolveGLBScene()` already treats the
  same content for the converter.
- The scene tree's per-row material name comes from the segment's own
  `materialIndex` only; there's no separate indicator when a segment's
  *rendered* appearance differs from its nominal material because a
  texture was disabled (texcoord/transform/decode-failure) — the model
  info panel's warnings list is the source of truth for that, not the
  scene tree row.
- Component-resolution (node-graph) cancellation is stage-boundary-only,
  matching `glb-to-stl.worker.ts`'s existing behavior — an extremely deep
  or wide scene graph's own traversal can't be interrupted mid-walk, only
  between the worker's parsing/resolving/building stages. This is an
  existing property of the GLB reader's pipeline this phase preserved,
  not a new gap introduced by the viewer.
- "Color by node" uses a deterministic internal palette (hashed from each
  segment's node index) — clearly labeled as a visualization aid in the
  UI copy, never presented as the file's real material appearance.

## Phase 3 completion summary

All six planned Phase 3 converters are now `"ready"` in the tool
registry: 3MF→STL (3A), OBJ→STL (3B), GLB→STL (3C), STL→OBJ (3D),
STL→3MF (3E) and PLY→STL (3F). Every converter shares the same Phase 1
foundation (file intake, Web Worker protocol, WASM loader, Three.js
viewport) and the same conventions established and refined across the
six implementations: a per-domain `ErrorCode` prefix with a
`xError()`/`toXSafeError()` pair, a format-neutral `src/lib/mesh/`
module for genuinely shared geometry algorithms (exact vertex dedup,
float32 text formatting, polygon triangulation) with thin
domain-specific compatibility wrappers at each original call site, and a
staged worker pipeline that reports progress honestly rather than
inventing stage boundaries that don't correspond to real, separate
passes over the data.

## Phase 4A completion summary

The OBJ Viewer (`/obj-viewer/`) is now `"ready"` in the tool registry —
the first of six planned Phase 4 viewers. It reuses the Phase 3B OBJ
reader's primitives completely unchanged (see "OBJ Viewer (Phase 4A)"
above) rather than forking a second parser, and it answered the previous
handoff's open scope question explicitly: it never fetches a referenced
`.mtl` library or any image, by design (see "Known limitations (Phase
4A)"). New, additive infrastructure from this phase that later viewers can
reuse as-is: the `OBJViewerSegment`/scene-tree pattern (object/group/
material/smoothing-group segmentation with per-segment bounds), the
index-buffer visibility technique (no geometry duplication per toggle),
the dual-normal-array shading-toggle pattern, and the
`OBJModelInfo`/`SceneTree`/`ViewerDisplayControls` component shapes.

## Phase 4B completion summary

The 3MF Viewer (`/3mf-viewer/`) is now `"ready"` in the tool registry —
the second of six planned Phase 4 viewers. It reuses the Phase 3A 3MF
reader's package/relationship/XML/transform/unit primitives completely
unchanged (see "3MF Viewer (Phase 4B)" above), answering every open
question the previous handoff raised: the scene tree segments by real
resolved-instance identity (not an invented heuristic), units are shown
declared *and* in millimeters (never "model units"), base-material and
color-group colors render directly from the package with a clearly
labeled neutral/embedded/color-by-object mode choice, and textures/
cross-part references are detected and disclosed rather than fetched.
New, additive infrastructure from this phase that later viewers can reuse
as-is: the `XMLHandler.onText` extension to `xml.ts` (for any future
format needing element text content, not just attributes), the
declared-unit + millimeter dual-display pattern, and the
embedded/neutral/object-color-mode UI pattern.

## Phase 4C completion summary

The GLB Viewer (`/glb-viewer/`) is now `"ready"` in the tool registry —
the third of six planned Phase 4 viewers. It reuses the Phase 3C GLB
reader's container/schema/accessor/transform/scene primitives completely
unchanged (see "GLB Viewer (Phase 4C)" above), and answers every open
question the previous handoff raised: segments key on resolved node
instances (not an invented heuristic), base-color textures embedded in
the GLB's own BIN chunk are decoded locally via `createImageBitmap()`
(a deliberate, documented exception to "the worker does everything," made
because decoding still has to cross to the main thread regardless of
where it happens), `POINTS`/`LINES`/`LINE_STRIP`/`LINE_LOOP` render
instead of being silently skipped, and dimensions show in glTF's real
meter unit rather than a generic "model units" label. New, additive
infrastructure this phase leaves for later viewers: the inverse-transpose
normal-matrix transform (correct under non-uniform scale and reflection
alike — any future viewer with node transforms and source normals can
reuse the same math), the `geometry.groups` + deduplicated material-array
pattern for genuine per-primitive materials without one-material-per-
triangle, and the worker-extracts/main-thread-decodes split for embedded
images.

## Known limitations (Phase 4D)

- Only the conventional `vertex1`/`vertex2` scalar-integer `edge` layout
  is recognized. Any other edge property naming is detected, counted as
  an unknown element, and skipped with a warning — never guessed at.
- UV pairs (`u`/`v`, `s`/`t`, `texture_u`/`texture_v`) are read and
  reported (`hasTextureCoordinates`) as metadata only. PLY has no
  portable texture-file concept at all, so this viewer never samples a
  UV pair against anything.
- The smooth-normal fallback (`computeSmoothNormals()`) decides validity
  per *vertex*, not per primitive — PLY has no primitive boundary the way
  GLB's per-primitive fallback does. A mesh with a genuinely intended
  hard edge between two faces sharing a vertex will still shade smoothly
  across it unless the file supplies its own valid `nx`/`ny`/`nz` for
  that vertex.
- Vertex color channels are normalized strictly by their own declared
  scalar type (`uint8`/`int8` → `/255`, `uint16`/`int16` → `/65535`,
  `float32`/`float64` → as-is); any other declared type is flagged
  invalid and clamped into `[0, 1]`, with a warning, rather than guessed.
- Degenerate-face handling is entirely `triangulatePolygon()`'s own
  existing policy (hard-reject a truly degenerate 3-vertex face; silently
  skip a degenerate ear within a larger polygon's fan) — the same
  behavior `/ply-to-stl/` already has, not a new viewer-specific rule.
- Body-reading cancellation is stage-boundary-only, matching every prior
  reader-side viewer in this project (OBJ/3MF/GLB) — the single
  interleaved vertex/face/edge pass itself can't be interrupted
  mid-loop, only between the worker's header/schema/geometry/build
  stages.
- Surface, edges and points share the *same* `BufferAttribute` instances
  for position/color/normal (never duplicated per category). This is
  safe specifically because all of a loaded model's up-to-three
  geometries are always disposed together, as one atomic group, in
  `disposeCurrentModel()` — never one at a time while a sibling geometry
  referencing the same attribute is still being rendered, which is the
  scenario where Three.js's per-geometry GPU-buffer release would
  otherwise pull a buffer out from under a still-live geometry.

## Phase 4D completion summary

The PLY Viewer (`/ply-viewer/`) is now `"ready"` in the tool registry —
the fourth of six planned Phase 4 viewers. It reuses the Phase 3F PLY
reader's header/scalar/ASCII/binary/triangulation primitives completely
unchanged (see "PLY Viewer (Phase 4D)" — the `viewer-resources.ts`/
`viewer-scene.ts` module docs above), and answers every open question the
previous handoff raised: a point-cloud-only file (vertices, no faces) is
a first-class, successful input — rejected only when there are literally
zero vertices, never when there are zero faces, unlike `/ply-to-stl/`'s
correct `PLY_FACE_ELEMENT_MISSING` rejection, which stays exactly as-is;
a flat three-category Surface/Explicit-edges/Points panel replaces any
invented scene tree, since that's genuinely all PLY has; UV pairs are
reported as metadata only, with no texture to decode, embedded or
otherwise; and explicit edges render as `LineSegments` when the file
declares the conventional `vertex1`/`vertex2` layout. New, additive
infrastructure this phase leaves for later viewers: the
shared-`BufferAttribute`-across-categories technique (see "Known
limitations (Phase 4D)" above) for a format with no per-instance
transforms, the per-category (`boundsSurface`/`boundsEdges`/
`boundsPoints`) bounds-subset pattern for "fit visible" without a
combined-bounds union, and the `PLYModelInfo`/`PLYGeometryPanel`/
`PLYDisplayControls` component shapes for any future format that's
similarly flat.

A dedicated regression test (`viewer-scene.test.ts`, "combined bounds
across surface + edges + points") protects the exact bug class the
Phase 4D handoff was written to guard against: a points-only vertex
correctly extends `boundsModelUnits` while being excluded from
`boundsSurface`, and an edge-only vertex correctly extends `boundsEdges`
while being excluded from `boundsSurface` — verifying per-category
bounds computation never silently drops a category the way GLB's
pre-fix `boundsMeters` once did (see "Phase 4C completion summary"
above).
