/**
 * Extracts embedded image bytes from a `Video` object's `Content`
 * property — binary FBX's own way of embedding a texture file directly
 * in the container (an `R` raw-binary property, unlike glTF's
 * base64/bufferView scheme). Only ever reads bytes already inside the
 * file: `RelativeFilename`/`Filename` are read only for display (a
 * sanitized label), never used to fetch anything. Format detection
 * sniffs the bytes' own magic number — FBX doesn't declare a MIME type
 * for embedded media the way glTF does — and decoding into pixels still
 * happens on the main thread via `createImageBitmap()`, exactly like the
 * GLB viewer's embedded textures (see that phase's own "Embedded images
 * and main-thread decoding" note): this module only ever extracts and
 * validates still-encoded bytes.
 */
import { findChild } from "./document";
import { fbxError } from "./errors";
import type { FBXNode, FBXLimits } from "./types";

export type FBXImageMimeType = "image/png" | "image/jpeg";

export interface FBXExtractedImage {
  mimeType: FBXImageMimeType;
  bytes: Uint8Array;
}

export interface FBXVideoContentResult {
  image: FBXExtractedImage | null;
  /** True when the Video object exists but declares no embedded bytes at all — an external-only media reference. Never fetched. */
  isExternalOnly: boolean;
  /** True when embedded bytes exist but aren't a format this viewer decodes (only PNG/JPEG are supported). */
  isUnsupportedFormat: boolean;
}

function sniffImageMime(bytes: Uint8Array): FBXImageMimeType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

export function extractVideoContent(node: FBXNode, limits: FBXLimits): FBXVideoContentResult {
  const contentNode = findChild(node, "Content");
  const contentProp = contentNode?.properties[0];

  if (!contentProp || contentProp.type !== "R" || contentProp.value.byteLength === 0) {
    return { image: null, isExternalOnly: true, isUnsupportedFormat: false };
  }

  const bytes = contentProp.value;
  if (bytes.byteLength > limits.maxImageBytes) throw fbxError("FBX_IMAGE_TOO_LARGE");

  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    return { image: null, isExternalOnly: false, isUnsupportedFormat: true };
  }

  return { image: { mimeType, bytes: bytes.slice() }, isExternalOnly: false, isUnsupportedFormat: false };
}
