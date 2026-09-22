export type ThreeDFileExtension = "stl" | "obj" | "3mf" | "glb" | "gltf" | "ply" | "fbx" | "gcode";

export interface FormatDefinition {
  extension: ThreeDFileExtension;
  label: string;
  /** Advisory only — extension is the source of truth. See validation.ts. */
  mimeTypes: string[];
}

export const FORMAT_REGISTRY: Record<ThreeDFileExtension, FormatDefinition> = {
  stl: { extension: "stl", label: "STL", mimeTypes: ["model/stl", "application/sla", "application/octet-stream"] },
  obj: { extension: "obj", label: "OBJ", mimeTypes: ["text/plain", "model/obj", "application/octet-stream"] },
  "3mf": {
    extension: "3mf",
    label: "3MF",
    mimeTypes: ["model/3mf", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml", "application/octet-stream"],
  },
  glb: { extension: "glb", label: "GLB", mimeTypes: ["model/gltf-binary", "application/octet-stream"] },
  gltf: { extension: "gltf", label: "glTF", mimeTypes: ["model/gltf+json", "application/json"] },
  ply: { extension: "ply", label: "PLY", mimeTypes: ["model/ply", "application/octet-stream"] },
  fbx: { extension: "fbx", label: "FBX", mimeTypes: ["application/octet-stream"] },
  gcode: { extension: "gcode", label: "G-code", mimeTypes: ["text/plain", "application/octet-stream"] },
};
