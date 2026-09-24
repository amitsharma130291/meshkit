/**
 * The exhaustive, lazily-loaded adapter map. `Record<DetectedFormat, ...>`
 * makes this exhaustive at *compile time* — adding a 7th `DetectedFormat`
 * value without adding its loader here is a TypeScript error, not a
 * runtime gap. Every entry is a genuine dynamic `import()`, so opening
 * `/viewer/` and detecting (say) OBJ never downloads the GLB or FBX
 * adapter's own module — each is its own Vite-emitted chunk, fetched
 * only once a file of that format is actually being processed.
 */
import type { DetectedFormat } from "./format-detection";
import type { ViewerAdapterModule } from "./adapter-types";

export const ADAPTER_LOADERS: Record<DetectedFormat, () => Promise<ViewerAdapterModule>> = {
  stl: () => import("./adapters/stl-adapter"),
  obj: () => import("./adapters/obj-adapter"),
  "3mf": () => import("./adapters/threemf-adapter"),
  glb: () => import("./adapters/glb-adapter"),
  ply: () => import("./adapters/ply-adapter"),
  fbx: () => import("./adapters/fbx-adapter"),
};
