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

## Known limitations (Phase 1)

- No real geometry parsing exists yet — `foundation.worker.ts` computes
  only byte length and a checksum, and `foundation.wasm` only adds two
  numbers.
- `ToolLayout`'s `related-tools` slot has no automatic wiring to
  `src/config/tools.ts`'s `relatedToolIds` yet; a future tool page
  populates it manually or a small helper is added when the pattern
  repeats across 2+ real tools.
- `public/_headers` uses the Netlify/Cloudflare Pages header-file
  convention. If the site deploys elsewhere (Vercel, a plain static
  host, etc.), translate these headers to that host's equivalent
  mechanism — the CSP hash-generation script
  (`scripts/generate-csp-headers.mjs`) will need a matching adjustment
  for how that host's header config is expressed.
- `transferableArrayBuffer` detection in `src/lib/browser/capabilities.ts`
  uses `typeof structuredClone === "function"` as a modern-browser
  proxy rather than testing actual transferable `postMessage` support
  directly; it's treated as optional/non-blocking, so a false negative
  only affects a UI hint, not functionality.

*(Phase 2 status update: `stl-viewer`'s registry `status` is now `"ready"`
per acceptance criteria; see "STL Viewer (Phase 2)" above.
`ToolLayout`'s `related-tools` slot is still populated manually by each
page — `/stl-viewer/` does this by looking up `relatedToolIds` from
`src/config/tools.ts` via `getToolById()` in its own frontmatter, exactly
as anticipated above. No automatic slot-filling helper was added yet;
still worth building once 2+ real tools repeat the pattern.)*

## Known limitations (Phase 2)

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

## Phase 4 handoff: OBJ Viewer

Recommended starting point, in order:

1. Phase 4 shifts from *converters* to *viewers* for formats beyond STL
   — the first is an OBJ Viewer, reusing `src/lib/obj/{tokenizer,indices,
   parser,convert}.ts` completely unchanged (the same parse pipeline
   `/obj-to-stl/` already uses) and `src/lib/three/viewport.ts` unchanged
   too. The new work is almost entirely in the page/worker layer, not the
   parsing layer.
2. Unlike a converter, a viewer never produces a downloadable file — its
   worker pipeline ends at `buildOBJGeometry()`'s `OBJParseResult`
   (positions/normals/bounds/warnings), never reaching
   `serializeBinarySTL()`. Follow `/stl-viewer/`'s page/worker shape (the
   viewer this project already has), not a converter's.
3. OBJ's "what's not preserved" warnings become more central to a viewer
   than a converter: a viewer's whole point is showing the user what
   their file actually contains, so materials/textures/vertex-colors/
   smooth-shading warnings should probably be more prominent (or paired
   with an actual textured preview — a genuinely new capability no
   converter has needed, since every converter so far targets STL, which
   cannot display texture either) rather than the converter pattern of "a
   warning box above the download button."
4. Decide, explicitly, whether an OBJ Viewer should attempt to load a
   referenced `.mtl` material library for a *visual* preview (unlike
   every converter, which correctly never fetches one, since STL output
   couldn't use it anyway) — this is a real, new privacy/scope question a
   viewer raises that no converter has had to answer, and should be
   resolved deliberately rather than by default.
5. Registry: add `obj-viewer` (or similar) as a new `viewer`-category
   entry — `planned` → `development` → `ready` — following the exact
   registry-status lifecycle every Phase 3 converter used.
