/**
 * Registry of tools this product plans to ship. This is a planning
 * artifact for future phases — Phase 1 does not generate any pages from
 * it. Only list a tool here once it is genuinely planned; do not add
 * placeholder entries just to pad the catalog.
 */
export type ToolCategory = "viewer" | "converter" | "diagnostic" | "repair" | "optimizer";
export type ToolStatus = "planned" | "development" | "ready";

export interface ToolDefinition {
  id: string;
  name: string;
  /** Future public route, e.g. "/stl-viewer/". Not yet built in Phase 1. */
  path: string;
  category: ToolCategory;
  description: string;
  inputFormats: string[];
  outputFormats?: string[];
  relatedToolIds?: string[];
  status: ToolStatus;
}

export const toolRegistry: ToolDefinition[] = [
  {
    id: "stl-viewer",
    name: "STL Viewer",
    path: "/stl-viewer/",
    category: "viewer",
    description: "Inspect STL geometry, dimensions and triangle count in your browser.",
    inputFormats: ["stl"],
    relatedToolIds: ["stl-repair", "stl-checker", "stl-to-obj", "stl-to-3mf", "reduce-stl-size"],
    status: "ready",
  },
  {
    id: "3mf-to-stl",
    name: "3MF to STL",
    path: "/3mf-to-stl/",
    category: "converter",
    description: "Convert 3MF models to STL without uploading the file.",
    inputFormats: ["3mf"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "obj-to-stl",
    name: "OBJ to STL",
    path: "/obj-to-stl/",
    category: "converter",
    description: "Convert OBJ models to STL locally in your browser.",
    inputFormats: ["obj"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "glb-to-stl",
    name: "GLB to STL",
    path: "/glb-to-stl/",
    category: "converter",
    description: "Convert GLB models to STL locally in your browser.",
    inputFormats: ["glb"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "stl-checker",
    name: "STL Checker",
    path: "/stl-checker/",
    category: "diagnostic",
    description: "Detect non-manifold edges, holes and flipped normals in an STL file.",
    inputFormats: ["stl"],
    relatedToolIds: ["stl-repair"],
    status: "planned",
  },
  {
    id: "stl-repair",
    name: "STL Repair",
    path: "/stl-repair/",
    category: "repair",
    description: "Repair holes, flipped normals and non-manifold geometry in an STL file.",
    inputFormats: ["stl"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-checker"],
    status: "planned",
  },
  {
    id: "stl-to-obj",
    name: "STL to OBJ",
    path: "/stl-to-obj/",
    category: "converter",
    description: "Convert an STL model to OBJ locally in your browser.",
    inputFormats: ["stl"],
    outputFormats: ["obj"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "stl-to-3mf",
    name: "STL to 3MF",
    path: "/stl-to-3mf/",
    category: "converter",
    description: "Convert an STL model to 3MF locally in your browser.",
    inputFormats: ["stl"],
    outputFormats: ["3mf"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "ply-to-stl",
    name: "PLY to STL",
    path: "/ply-to-stl/",
    category: "converter",
    description: "Convert PLY (Polygon File Format) models to STL locally in your browser.",
    inputFormats: ["ply"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-viewer"],
    status: "ready",
  },
  {
    id: "reduce-stl-size",
    name: "Reduce STL File Size",
    path: "/reduce-stl-file-size/",
    category: "optimizer",
    description: "Simplify an STL model's triangle count to shrink its file size locally in your browser.",
    inputFormats: ["stl"],
    outputFormats: ["stl"],
    relatedToolIds: ["stl-viewer"],
    status: "planned",
  },
];

export function getToolById(id: string): ToolDefinition | undefined {
  return toolRegistry.find((tool) => tool.id === id);
}
