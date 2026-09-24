/**
 * Deterministic 3MF/ZIP fixture builders used only by tests — never
 * imported by app code. Uses `fflate`'s `zipSync` (a well-tested library)
 * to construct valid archives; malicious fixtures (encrypted-flag,
 * corruption) are produced by patching the resulting bytes directly,
 * since fflate has no API to create them on purpose.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import { expect } from "vitest";
import { ThreeMFParseException, type ThreeMFErrorCode } from "./errors";

const RELS_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

export interface MeshObjectFixture {
  id: string;
  kind: "mesh";
  vertices: [number, number, number][];
  triangles: [number, number, number][];
  /** Viewer-only, additive: object display name / default color-property reference. */
  name?: string;
  pid?: string;
  pindex?: number;
  /** Viewer-only, additive: raw `<triangle .../>` strings used instead of the auto-generated v1/v2/v3 ones — for tests needing pid/p1/p2/p3, which the plain `triangles` tuples can't express. Must have the same length as `triangles` when provided. */
  triangleXML?: string[];
}

export interface ComponentsObjectFixture {
  id: string;
  kind: "components";
  components: { objectId: string; transform?: string; path?: string }[];
  /** Viewer-only, additive. */
  name?: string;
}

export type ObjectFixture = MeshObjectFixture | ComponentsObjectFixture;

export function meshObject(
  id: string,
  vertices: [number, number, number][],
  triangles: [number, number, number][],
): MeshObjectFixture {
  return { id, kind: "mesh", vertices, triangles };
}

export function simpleTriangleMesh(id = "1"): MeshObjectFixture {
  return meshObject(
    id,
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
    [[0, 1, 2]],
  );
}

export interface ModelXMLOptions {
  unit?: string;
  objects: ObjectFixture[];
  buildItems: { objectId: string; transform?: string; partnumber?: string; path?: string }[];
  unsupportedFeatures?: ("basematerials" | "colorgroup" | "texture2d" | "metadata")[];
  /** Omit the unit attribute entirely (to test the spec default) instead of using `unit`. */
  omitUnitAttribute?: boolean;
  /** Viewer-only, additive: raw XML injected into <resources>, before the objects — for basematerials/colorgroup/metadata fixtures the fixed `unsupportedFeatures` placeholders can't express. */
  resourcesXML?: string;
}

export function buildModelXML(options: ModelXMLOptions): string {
  const unitAttr = options.omitUnitAttribute ? "" : ` unit="${options.unit ?? "millimeter"}"`;
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model${unitAttr} xmlns="${CORE_NAMESPACE}"><resources>`,
  ];

  for (const feature of options.unsupportedFeatures ?? []) {
    if (feature === "metadata") lines.push(`<metadata name="Title">Fixture</metadata>`);
    if (feature === "basematerials")
      lines.push(`<basematerials id="900"><base name="x" displaycolor="#FFFFFFFF"/></basematerials>`);
    if (feature === "colorgroup") lines.push(`<colorgroup id="901"><color color="#FF0000FF"/></colorgroup>`);
    if (feature === "texture2d") lines.push(`<texture2d id="902" path="/2D/tex.png" contenttype="image/png"/>`);
  }

  if (options.resourcesXML) lines.push(options.resourcesXML);

  for (const obj of options.objects) {
    const nameAttr = obj.name ? ` name="${obj.name}"` : "";
    if (obj.kind === "mesh") {
      const pidAttr = obj.pid !== undefined ? ` pid="${obj.pid}"` : "";
      const pindexAttr = obj.pindex !== undefined ? ` pindex="${obj.pindex}"` : "";
      lines.push(`<object id="${obj.id}" type="model"${nameAttr}${pidAttr}${pindexAttr}><mesh><vertices>`);
      for (const [x, y, z] of obj.vertices) lines.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
      lines.push(`</vertices><triangles>`);
      if (obj.triangleXML) {
        for (const t of obj.triangleXML) lines.push(t);
      } else {
        for (const [v1, v2, v3] of obj.triangles) lines.push(`<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
      }
      lines.push(`</triangles></mesh></object>`);
    } else {
      lines.push(`<object id="${obj.id}" type="model"${nameAttr}><components>`);
      for (const c of obj.components) {
        const pathAttr = c.path ? ` path="${c.path}"` : "";
        lines.push(`<component objectid="${c.objectId}"${c.transform ? ` transform="${c.transform}"` : ""}${pathAttr}/>`);
      }
      lines.push(`</components></object>`);
    }
  }

  lines.push(`</resources><build>`);
  for (const item of options.buildItems) {
    const partnumberAttr = item.partnumber ? ` partnumber="${item.partnumber}"` : "";
    const pathAttr = item.path ? ` path="${item.path}"` : "";
    lines.push(`<item objectid="${item.objectId}"${item.transform ? ` transform="${item.transform}"` : ""}${partnumberAttr}${pathAttr}/>`);
  }
  lines.push(`</build></model>`);
  return lines.join("");
}

export function buildRelsXML(modelPath: string, opts?: { external?: boolean; namespacePrefix?: string }): string {
  const p = opts?.namespacePrefix ? `${opts.namespacePrefix}:` : "";
  const xmlns = opts?.namespacePrefix
    ? ` xmlns:${opts.namespacePrefix}="http://schemas.openxmlformats.org/package/2006/relationships"`
    : ` xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`;
  const targetMode = opts?.external ? ' TargetMode="External"' : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${p}Relationships${xmlns}>` +
    `<${p}Relationship Id="rel0" Type="${RELS_TYPE}" Target="${opts?.external ? "http://example.com/model" : `/${modelPath}`}"${targetMode}/>` +
    `</${p}Relationships>`
  );
}

export interface PackageOptions {
  modelPath?: string;
  skipRels?: boolean;
  relsXML?: string;
  extraFiles?: Record<string, string>;
}

export function build3MFPackage(modelXML: string, options: PackageOptions = {}): ArrayBuffer {
  const modelPath = options.modelPath ?? "3D/3dmodel.model";
  const files: Zippable = {};

  if (!options.skipRels) {
    files["_rels/.rels"] = strToU8(options.relsXML ?? buildRelsXML(modelPath));
  }
  files[modelPath] = strToU8(modelXML);
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
  );
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    files[path] = strToU8(content);
  }

  const zipped = zipSync(files);
  return toArrayBuffer(zipped);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Flips the ZIP encryption bit (general-purpose flag bit 0) for one entry, in both its local header and central directory record. */
export function markEntryEncrypted(buffer: ArrayBuffer, entryName: string): ArrayBuffer {
  const bytes = new Uint8Array(buffer.slice(0));
  const nameBytes = strToU8(entryName);

  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
      if (nameLen === nameBytes.length && bytesEqual(bytes, i + 30, nameBytes)) {
        bytes[i + 6] |= 0x01;
      }
    } else if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
      const nameLen = bytes[i + 28] | (bytes[i + 29] << 8);
      if (nameLen === nameBytes.length && bytesEqual(bytes, i + 46, nameBytes)) {
        bytes[i + 8] |= 0x01;
      }
    }
  }
  return bytes.buffer;
}

function bytesEqual(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

/** Asserts `fn` throws a `ThreeMFParseException` with the given code. */
export function expectThreeMFError(fn: () => unknown, code: ThreeMFErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ThreeMFParseException);
    expect((error as ThreeMFParseException).code).toBe(code);
    return;
  }
  expect.fail(`expected function to throw ${code}`);
}
