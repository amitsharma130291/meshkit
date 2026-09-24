// Authoritative route inventory for the Phase 7 SEO audit.
//
// This is deliberately hand-authored rather than derived purely from
// `dist/` at audit time: the audit needs to know what a route is SUPPOSED
// to be (its classification, intended indexability, expected sitemap
// membership) in order to catch a route that accidentally drifted from
// that intent — deriving the expectation from the same build output being
// checked would make every check trivially pass. `tests/unit/seo/
// route-manifest.test.ts` cross-checks this list's pathnames against the
// real `src/pages/**/index.astro` glob and the tool registry, so the two
// sources of truth (this manifest, and the actual repo) can't silently
// drift from each other.
//
// classification is one of:
//   indexable-primary    — a tool's main, canonical route
//   indexable-intent-page — a distinct-intent secondary route for a tool
//                           that already has a primary route elsewhere
//   canonical-alias       — no page of its own; a redirect to another route
//   noindex-utility       — a built page, intentionally excluded from search
//   development-only      — an internal/proof page, never public
//
// toolId links a route back to `src/config/tools.ts` for cross-checking
// (status, relatedToolIds) — null for non-tool routes (home, redirects,
// dev pages).

export const routeManifest = [
  {
    pathname: "/",
    classification: "indexable-primary",
    toolId: null,
    primaryIntent: "MeshWrench brand / tool directory entry point",
  },
  {
    pathname: "/stl-viewer/",
    classification: "indexable-primary",
    toolId: "stl-viewer",
    primaryIntent: "view an STL file online",
  },
  {
    pathname: "/obj-viewer/",
    classification: "indexable-primary",
    toolId: "obj-viewer",
    primaryIntent: "view an OBJ file online",
  },
  {
    pathname: "/3mf-viewer/",
    classification: "indexable-primary",
    toolId: "3mf-viewer",
    primaryIntent: "view a 3MF file online",
  },
  {
    pathname: "/glb-viewer/",
    classification: "indexable-primary",
    toolId: "glb-viewer",
    primaryIntent: "view a GLB file online",
  },
  {
    pathname: "/ply-viewer/",
    classification: "indexable-primary",
    toolId: "ply-viewer",
    primaryIntent: "view a PLY file online",
  },
  {
    pathname: "/fbx-viewer/",
    classification: "indexable-primary",
    toolId: "fbx-viewer",
    primaryIntent: "view a binary FBX file online",
  },
  {
    pathname: "/viewer/",
    classification: "indexable-primary",
    toolId: "viewer",
    primaryIntent: "open any supported 3D file format in one universal viewer",
  },
  {
    pathname: "/3mf-to-stl/",
    classification: "indexable-primary",
    toolId: "3mf-to-stl",
    primaryIntent: "convert 3MF to STL",
  },
  {
    pathname: "/obj-to-stl/",
    classification: "indexable-primary",
    toolId: "obj-to-stl",
    primaryIntent: "convert OBJ to STL",
  },
  {
    pathname: "/glb-to-stl/",
    classification: "indexable-primary",
    toolId: "glb-to-stl",
    primaryIntent: "convert GLB to STL",
  },
  {
    pathname: "/ply-to-stl/",
    classification: "indexable-primary",
    toolId: "ply-to-stl",
    primaryIntent: "convert PLY to STL",
  },
  {
    pathname: "/stl-to-obj/",
    classification: "indexable-primary",
    toolId: "stl-to-obj",
    primaryIntent: "convert STL to OBJ",
  },
  {
    pathname: "/stl-to-3mf/",
    classification: "indexable-primary",
    toolId: "stl-to-3mf",
    primaryIntent: "convert STL to 3MF",
  },
  {
    pathname: "/stl-checker/",
    classification: "indexable-primary",
    toolId: "stl-checker",
    primaryIntent: "check an STL file for mesh problems (diagnose, not fix)",
  },
  {
    pathname: "/stl-validator/",
    classification: "indexable-intent-page",
    toolId: "stl-validator",
    primaryIntent: "validate STL watertightness against a disclosed rule set",
  },
  {
    pathname: "/stl-repair/",
    classification: "indexable-primary",
    toolId: "stl-repair",
    primaryIntent: "repair an STL file's mesh problems (fix, not just detect)",
  },
  {
    pathname: "/make-stl-watertight/",
    classification: "indexable-intent-page",
    toolId: "make-stl-watertight",
    primaryIntent: "close holes / make an STL watertight",
  },
  {
    pathname: "/repair-non-manifold-stl/",
    classification: "indexable-intent-page",
    toolId: "repair-non-manifold-stl",
    primaryIntent: "fix non-manifold edges in an STL",
  },
  {
    pathname: "/reduce-stl-file-size/",
    classification: "indexable-primary",
    toolId: "reduce-stl-size",
    primaryIntent: "reduce an STL file's size by reducing triangle count",
  },
  {
    pathname: "/simplify-stl/",
    classification: "indexable-intent-page",
    toolId: "simplify-stl",
    primaryIntent: "simplify an STL mesh (modeling/detail framing, not file size)",
  },
  {
    pathname: "/stl-triangle-reducer/",
    classification: "indexable-intent-page",
    toolId: "stl-triangle-reducer",
    primaryIntent: "reduce STL triangles to an explicit target (slicer facet-limit framing)",
  },
  {
    pathname: "/gcode-viewer/",
    classification: "indexable-primary",
    toolId: "gcode-viewer",
    primaryIntent: "open a G-code file and inspect its statistics",
  },
  {
    pathname: "/gcode-visualizer/",
    classification: "indexable-intent-page",
    toolId: "gcode-visualizer",
    primaryIntent: "render a G-code file's categorized toolpaths (feature/movement/tool/feed-rate color)",
  },
  {
    pathname: "/gcode-simulator/",
    classification: "indexable-intent-page",
    toolId: "gcode-simulator",
    primaryIntent: "play back a G-code file's parsed tool movement visually",
  },
  {
    pathname: "/gcode-layer-viewer/",
    classification: "indexable-intent-page",
    toolId: "gcode-layer-viewer",
    primaryIntent: "inspect a G-code file layer by layer (single/cumulative/full-model)",
  },
  {
    pathname: "/gcode-toolpath-viewer/",
    classification: "indexable-intent-page",
    toolId: "gcode-toolpath-viewer",
    primaryIntent: "analyze a G-code file's extrusion, travel, tool and feed-rate statistics",
  },
  {
    pathname: "/online-stl-viewer/",
    classification: "canonical-alias",
    toolId: null,
    primaryIntent: "301 redirect to /stl-viewer/ — same intent, avoids duplicate content",
    redirectsTo: "/stl-viewer/",
  },
  {
    pathname: "/foundation-preview/",
    classification: "development-only",
    toolId: null,
    primaryIntent: "internal architecture proof, never a public tool",
  },
  {
    pathname: "/pricing/",
    classification: "indexable-primary",
    toolId: null,
    primaryIntent: "buy Pro, activate a license key, or recover a forgotten license key",
  },
  {
    pathname: "/pro/welcome/",
    classification: "noindex-utility",
    toolId: null,
    primaryIntent: "post-checkout landing page (Dodo Payments return_url) that activates the license and hands off to the app — a real page, but never a search destination",
  },
  {
    pathname: "/contact/",
    classification: "indexable-primary",
    toolId: null,
    primaryIntent: "send a message to the team — questions, feedback, or support requests",
  },
];

export function getRouteEntry(pathname) {
  return routeManifest.find((r) => r.pathname === pathname);
}

export function isIndexableClassification(classification) {
  return classification === "indexable-primary" || classification === "indexable-intent-page";
}

export const expectedIndexablePathnames = routeManifest
  .filter((r) => isIndexableClassification(r.classification))
  .map((r) => r.pathname);
