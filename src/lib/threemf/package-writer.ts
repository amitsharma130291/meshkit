/**
 * Packages a generated model XML document into a minimal, valid 3MF
 * (OPC/ZIP) container: exactly the three entries a 3MF reader requires —
 * `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model` — nothing
 * else. Uses `fflate`'s `zipSync()` to do the actual compression: unlike
 * `package.ts` (the ZIP *reader*, hand-rolled specifically so it can
 * inspect encryption flags fflate's high-level read API hides), there's
 * no equivalent safety reason to avoid a well-tested writer here —
 * MeshKit controls every byte being written, so there's no untrusted
 * input to validate around. A fixed `mtime` is applied to every entry so
 * identical geometry produces byte-identical package output.
 */
import { strToU8, zipSync } from "fflate";
import { threeMFError } from "./errors";
import { CONVENTIONAL_MODEL_PATH, MODEL_RELATIONSHIP_TYPE } from "./relationships";

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const RELS_PATH = "_rels/.rels";
const RELATIONSHIP_ID = "rel0";

const CONTENT_TYPES_XML = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>`,
  `</Types>`,
].join("");

const RELS_XML = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
  `<Relationship Id="${RELATIONSHIP_ID}" Type="${MODEL_RELATIONSHIP_TYPE}" Target="/${CONVENTIONAL_MODEL_PATH}"/>`,
  `</Relationships>`,
].join("");

/**
 * Deterministic across runs — real wall-clock timestamps would make
 * otherwise-identical geometry produce different package bytes every
 * time. ZIP's DOS-style timestamp field only represents 1980–2099 (the
 * classic DOS epoch), so this can't be the Unix epoch (1970) — any fixed
 * in-range date works equally well.
 */
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z");

export interface PackageWriteLimits {
  maxOutputBytes: number;
}

export function writeThreeMFPackage(modelXML: string, limits: PackageWriteLimits): ArrayBuffer {
  let zipped: Uint8Array;
  try {
    zipped = zipSync(
      {
        [CONTENT_TYPES_PATH]: strToU8(CONTENT_TYPES_XML),
        [RELS_PATH]: strToU8(RELS_XML),
        [CONVENTIONAL_MODEL_PATH]: strToU8(modelXML),
      },
      { mtime: FIXED_MTIME, level: 6 },
    );
  } catch {
    throw threeMFError("THREEMF_PACKAGE_WRITE_FAILED");
  }

  if (zipped.byteLength > limits.maxOutputBytes) {
    throw threeMFError("THREEMF_OUTPUT_TOO_LARGE");
  }

  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}
