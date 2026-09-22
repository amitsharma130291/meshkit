// One-off generator for public/wasm/foundation.wasm.
//
// This hand-assembles a minimal, valid WebAssembly binary module (no
// toolchain dependency) that exports a single function:
//
//   (func $add (param i32) (param i32) (result i32)
//     local.get 0
//     local.get 1
//     i32.add)
//   (export "add" (func $add))
//
// It exists only to prove the foundation's WASM loader can fetch, compile,
// instantiate and call a local .wasm module. It is not a geometry library
// and must never be mistaken for one. Re-run with `node scripts/generate-foundation-wasm.mjs`
// if the fixture ever needs to be regenerated.

import { writeFile } from "node:fs/promises";
import path from "node:path";

const bytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, // magic: \0asm
  0x01, 0x00, 0x00, 0x00, // version: 1

  // Type section: (i32, i32) -> i32
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,

  // Function section: function 0 uses type 0
  0x03, 0x02, 0x01, 0x00,

  // Export section: export function 0 as "add"
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,

  // Code section: local.get 0; local.get 1; i32.add; end
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const outPath = path.resolve(process.cwd(), "public/wasm/foundation.wasm");
await writeFile(outPath, bytes);
console.log(`Wrote ${bytes.byteLength} bytes to ${outPath}`);
