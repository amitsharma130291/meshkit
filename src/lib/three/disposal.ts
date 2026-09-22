import type { Material, Object3D, Texture, WebGLRenderer } from "three";

interface DisposableMesh {
  geometry?: { dispose?: () => void };
  material?: Material | Material[];
}

function isTexture(value: unknown): value is Texture {
  return typeof value === "object" && value !== null && "isTexture" in value;
}

function disposeMaterial(material: Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (isTexture(value)) value.dispose();
  }
  material.dispose();
}

/** Walks a scene graph disposing every geometry, material and texture it owns. Does not dispose the renderer. */
export function disposeObject3D(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as unknown as DisposableMesh;
    mesh.geometry?.dispose?.();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(disposeMaterial);
    }
  });
}

/** Disposes the renderer's GL context and removes its canvas from the DOM. */
export function disposeRenderer(renderer: WebGLRenderer): void {
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.parentElement?.removeChild(renderer.domElement);
}
