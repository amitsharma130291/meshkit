/**
 * Single source of truth for cross-page product facts. Page and component
 * code should import from here rather than hard-coding copy like the
 * product name, price or privacy promise in multiple places.
 */
import { PRODUCTION_SITE_URL, validateProductionSiteUrl } from "./site-url";

export interface SiteConfig {
  productName: string;
  defaultTitle: string;
  defaultDescription: string;
  /** Canonical origin, no trailing slash. Update this and `astro.config.mjs`'s `site` together. */
  siteUrl: string;
  social: {
    ogType: string;
  };
  /** Formats an actually-shipped tool reads today. Kept accurate for the
   *  foundation-preview proof page's own file-accept list; page-facing
   *  format claims should derive from `toolRegistry` directly instead. */
  launchFormats: string[];
  privacyPromise: string;
  proPriceUsd: number;
  defaultSocialImage: string;
}

export const siteConfig: SiteConfig = {
  productName: "MeshWrench",
  defaultTitle: "MeshWrench — Private 3D File Tools",
  defaultDescription:
    "View, convert, repair, and optimize 3D files locally in your browser. Your files never leave your device.",
  siteUrl: PRODUCTION_SITE_URL,
  social: {
    ogType: "website",
  },
  launchFormats: ["stl", "3mf", "obj", "glb", "ply", "fbx"],
  privacyPromise: "100% local processing — your files never leave your computer",
  proPriceUsd: 39,
  /** Default Open Graph/Twitter preview image, relative to the site root.
   *  Its real pixel dimensions (not the 4:3-landscape 1200×630 baseline)
   *  are declared alongside it in SEOHead.astro — see that file's own
   *  note on why a proper crop is a documented follow-up, not silently
   *  faked here. */
  defaultSocialImage: "/mesh-hero.png",
};

// Fails loudly at build/import time — never a silent regression to a
// placeholder, localhost, or malformed origin. See `site-url.ts`.
const validation = validateProductionSiteUrl(siteConfig.siteUrl);
if (!validation.ok) {
  throw new Error(`siteConfig.siteUrl is invalid: ${validation.reason}`);
}
