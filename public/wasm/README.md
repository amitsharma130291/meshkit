# /wasm

Static WebAssembly modules served as-is. Every future geometry/processing
WASM module belongs here, loaded through `src/lib/wasm/wasm-loader.ts`.

## foundation.wasm

A 41-byte, hand-assembled module that exports a single `add(a, b)`
function. It exists **only** to prove `loadWasmModule()` can fetch,
compile and instantiate a local `.wasm` file — it is not a geometry
library and must never be treated as one. Regenerate it (if it's ever
lost or needs to change) with:

```bash
node scripts/generate-foundation-wasm.mjs
```

See `docs/ARCHITECTURE.md` for the WASM loading contract, required MIME
type and CSP implications.
