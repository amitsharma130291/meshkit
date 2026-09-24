/**
 * Extracts embedded image bytes for the viewer. Reuses `resolveBufferView()`
 * unchanged — the exact same bounds-checked BIN-chunk reader
 * `accessors.ts` already uses for geometry — so an image's byte range gets
 * identical safety guarantees to any accessor's. Decoding the bytes into
 * pixels happens on the main thread (see the client and docs), never here:
 * this module only ever extracts and validates still-encoded bytes.
 */
import { resolveBufferView } from "./accessors";
import { glbError } from "./errors";
import type { GLTFDocument } from "./types";
import type { RawGLTFImage } from "./viewer-resources";
import type { GLBViewerImage, GLBViewerLimits } from "./viewer-types";

const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

export interface ExtractedImages {
  /** Same length and order as the source `images` array; `null` for any image that's external (`uri`-based), unsupported, or invalid — never fetched or guessed at. */
  images: (GLBViewerImage | null)[];
  hasUnsupportedMime: boolean;
}

export function extractViewerImages(doc: GLTFDocument, bin: Uint8Array | null, rawImages: RawGLTFImage[], limits: GLBViewerLimits): ExtractedImages {
  let hasUnsupportedMime = false;

  const images = rawImages.map((raw): GLBViewerImage | null => {
    if (raw.bufferViewIndex === null) return null; // external (uri-based) — never fetched
    if (raw.mimeType === null || !SUPPORTED_MIME_TYPES.has(raw.mimeType)) {
      hasUnsupportedMime = true;
      return null;
    }

    let view: ReturnType<typeof resolveBufferView>;
    try {
      view = resolveBufferView(doc, raw.bufferViewIndex, bin);
    } catch (error) {
      if (error instanceof Error && error.name === "GLBParseException") throw error;
      throw glbError("GLB_IMAGE_REFERENCE_INVALID");
    }

    if (view.data.byteLength === 0) return null; // empty payload — nothing to decode
    if (view.data.byteLength > limits.maxImageBytes) throw glbError("GLB_VIEWER_IMAGE_LIMIT");

    return { mimeType: raw.mimeType, bytes: view.data.slice() };
  });

  return { images, hasUnsupportedMime };
}
