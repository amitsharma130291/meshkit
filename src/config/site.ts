/**
 * Single source of truth for cross-page product facts. Page and component
 * code should import from here rather than hard-coding copy like the
 * product name, price or privacy promise in multiple places.
 */
export interface SiteConfig {
  productName: string;
  defaultTitle: string;
  defaultDescription: string;
  /** Canonical origin, no trailing slash. Update this and `astro.config.mjs`'s `site` together. */
  siteUrl: string;
  social: {
    ogType: string;
  };
  /** Formats the free tools will support at first public launch. */
  launchFormats: string[];
  privacyPromise: string;
  proPriceUsd: number;
}

export const siteConfig: SiteConfig = {
  productName: "MeshKit",
  defaultTitle: "MeshKit — Private 3D File Tools",
  defaultDescription:
    "Open, inspect, convert and repair 3D files privately in your browser. No uploads, no signup and no waiting.",
  siteUrl: "https://example.com",
  social: {
    ogType: "website",
  },
  launchFormats: ["stl", "3mf", "obj", "glb", "gcode"],
  privacyPromise: "100% local processing — your files never leave your computer",
  proPriceUsd: 39,
};
