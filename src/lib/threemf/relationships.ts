import { threeMFError } from "./errors";
import { parseXML, type XMLAttributes } from "./xml";
import type { ThreeMFPackage } from "./package";

const RELS_PATH = "_rels/.rels";
/** Conventional fallback location, used only when no usable relationship exists — see findPrimaryModelPath. Also exported as the one path `package-writer.ts` targets, since this converter always writes (and points its relationship at) this exact location. */
export const CONVENTIONAL_MODEL_PATH = "3D/3dmodel.model";
/** Exported so `package-writer.ts` (the write side) declares the identical relationship type — one source of truth, never allowed to drift between reader and writer. */
export const MODEL_RELATIONSHIP_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

interface Relationship {
  type: string;
  target: string;
  targetMode: string | undefined;
}

/**
 * Locates the package's primary 3D model part using OPC relationships
 * (`_rels/.rels`) — never by string-matching the XML, and never by
 * assuming a fixed path without checking relationships first.
 */
export function findPrimaryModelPath(pkg: ThreeMFPackage): string {
  if (!pkg.entryNames.has(RELS_PATH)) {
    return fallbackToConventionalPath(pkg);
  }

  const relationships = parseRelationships(decodeUtf8(pkg.readEntry(RELS_PATH)));
  const modelRelationships = relationships.filter((r) => r.type === MODEL_RELATIONSHIP_TYPE);

  if (modelRelationships.length === 0) {
    return fallbackToConventionalPath(pkg);
  }
  if (modelRelationships.length > 1) {
    throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
  }

  const relationship = modelRelationships[0];
  if (relationship.targetMode === "External") {
    // External relationships point outside the package — never fetched, and
    // not usable as the primary model source.
    throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
  }

  const resolved = resolvePackagePath(relationship.target);
  if (!pkg.entryNames.has(resolved)) {
    throw threeMFError("THREEMF_MODEL_PART_MISSING");
  }
  return resolved;
}

function fallbackToConventionalPath(pkg: ThreeMFPackage): string {
  // Documented, narrow fallback: only used when `_rels/.rels` is absent or
  // contains no usable 3D-model relationship — never as a silent guess
  // among multiple candidates.
  if (pkg.entryNames.has(CONVENTIONAL_MODEL_PATH)) {
    return CONVENTIONAL_MODEL_PATH;
  }
  throw threeMFError("THREEMF_MODEL_PART_MISSING");
}

function parseRelationships(xml: string): Relationship[] {
  const relationships: Relationship[] = [];
  try {
    parseXML(xml, {
      onStartElement(localName: string, attributes: XMLAttributes) {
        if (localName !== "Relationship") return;
        const type = attributes.Type;
        const target = attributes.Target;
        if (typeof type !== "string" || typeof target !== "string") {
          throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
        }
        relationships.push({ type, target, targetMode: attributes.TargetMode });
      },
      onEndElement() {
        /* no-op */
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ThreeMFParseException") throw error;
    throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
  }
  return relationships;
}

/** Resolves a relationship Target (relative to the package root, for `_rels/.rels`) into a normalized package-internal path. */
function resolvePackagePath(target: string): string {
  if (target.length === 0 || target.includes("\0") || target.includes("\\")) {
    throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
  }
  // Absolute-in-package targets (leading "/") are relative to the package
  // root already; relative targets (the common case) are too, since the
  // source part here is always `_rels/.rels` at the root.
  const path = target.startsWith("/") ? target.slice(1) : target;

  const outputSegments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (outputSegments.length === 0) {
        // Escapes above the package root.
        throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
      }
      outputSegments.pop();
      continue;
    }
    outputSegments.push(segment);
  }
  if (outputSegments.length === 0) {
    throw threeMFError("THREEMF_RELATIONSHIP_INVALID");
  }
  return outputSegments.join("/");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
