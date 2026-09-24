/**
 * Deterministic binary FBX fixture builders used only by tests — never
 * imported by app code. Mirrors binary-parser.ts's own layout rules
 * exactly (same magic, same 32-/64-bit record-field switch at FBX 7500,
 * same null-record terminator convention) so a round trip through
 * `buildFBXBinary` → `parseFBXBinary` exercises the real format, not a
 * simplified stand-in for it.
 */
import { zlibSync } from "fflate";
import { expect } from "vitest";
import { FBXParseException, type FBXErrorCode } from "./errors";

export type FixtureProperty =
  | { type: "Y"; value: number }
  | { type: "C"; value: boolean }
  | { type: "I"; value: number }
  | { type: "F"; value: number }
  | { type: "D"; value: number }
  | { type: "L"; value: bigint }
  | { type: "f"; value: number[]; compress?: boolean }
  | { type: "d"; value: number[]; compress?: boolean }
  | { type: "l"; value: bigint[]; compress?: boolean }
  | { type: "i"; value: number[]; compress?: boolean }
  | { type: "b"; value: number[]; compress?: boolean }
  | { type: "S"; value: string }
  | { type: "R"; value: Uint8Array };

export interface FixtureNode {
  name: string;
  properties?: FixtureProperty[];
  children?: FixtureNode[];
}

class ByteWriter {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  i16(v: number): void {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setInt16(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  u32(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  i32(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  f32(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  f64(v: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  i64(v: bigint): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigInt64(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
  }

  u64(v: bigint | number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, typeof v === "bigint" ? v : BigInt(v), true);
    this.bytes.push(...new Uint8Array(buf));
  }

  bytesRaw(v: Uint8Array | number[]): void {
    this.bytes.push(...v);
  }

  patchU32(pos: number, v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, v, true);
    const arr = new Uint8Array(buf);
    for (let i = 0; i < 4; i++) this.bytes[pos + i] = arr[i];
  }

  patchU64(pos: number, v: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(v), true);
    const arr = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) this.bytes[pos + i] = arr[i];
  }

  toArrayBuffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}

const ARRAY_ELEMENT_SIZE: Record<"f" | "d" | "l" | "i" | "b", number> = { f: 4, d: 8, l: 8, i: 4, b: 1 };

function encodeArrayPayload(prop: Extract<FixtureProperty, { type: "f" | "d" | "l" | "i" | "b" }>): Uint8Array {
  const count = prop.value.length;
  const size = ARRAY_ELEMENT_SIZE[prop.type];
  const buf = new ArrayBuffer(count * size);
  const view = new DataView(buf);
  for (let i = 0; i < count; i++) {
    const o = i * size;
    if (prop.type === "f") view.setFloat32(o, prop.value[i] as number, true);
    else if (prop.type === "d") view.setFloat64(o, prop.value[i] as number, true);
    else if (prop.type === "l") view.setBigInt64(o, prop.value[i] as bigint, true);
    else if (prop.type === "i") view.setInt32(o, prop.value[i] as number, true);
    else view.setUint8(o, prop.value[i] as number);
  }
  return new Uint8Array(buf);
}

function writeProperty(w: ByteWriter, prop: FixtureProperty): void {
  w.u8(prop.type.charCodeAt(0));
  switch (prop.type) {
    case "Y":
      w.i16(prop.value);
      return;
    case "C":
      w.u8(prop.value ? 1 : 0);
      return;
    case "I":
      w.i32(prop.value);
      return;
    case "F":
      w.f32(prop.value);
      return;
    case "D":
      w.f64(prop.value);
      return;
    case "L":
      w.i64(prop.value);
      return;
    case "f":
    case "d":
    case "l":
    case "i":
    case "b": {
      const raw = encodeArrayPayload(prop);
      const compress = prop.compress ?? false;
      const payload = compress ? zlibSync(raw) : raw;
      w.u32(prop.value.length);
      w.u32(compress ? 1 : 0);
      w.u32(payload.length);
      w.bytesRaw(payload);
      return;
    }
    case "S": {
      const bytes = new TextEncoder().encode(prop.value);
      w.u32(bytes.length);
      w.bytesRaw(bytes);
      return;
    }
    case "R": {
      w.u32(prop.value.length);
      w.bytesRaw(prop.value);
      return;
    }
  }
}

function writeNode(w: ByteWriter, node: FixtureNode, uses64Bit: boolean): void {
  const offsetFieldSize = uses64Bit ? 8 : 4;
  const endOffsetPos = w.length;
  if (uses64Bit) w.u64(0);
  else w.u32(0);
  const numPropsPos = w.length;
  if (uses64Bit) w.u64(0);
  else w.u32(0);
  const propListLenPos = w.length;
  if (uses64Bit) w.u64(0);
  else w.u32(0);

  const nameBytes = new TextEncoder().encode(node.name);
  w.u8(nameBytes.length);
  w.bytesRaw(nameBytes);

  const props = node.properties ?? [];
  const propListStart = w.length;
  for (const p of props) writeProperty(w, p);
  const propListLen = w.length - propListStart;

  const children = node.children ?? [];
  if (children.length > 0) {
    for (const child of children) writeNode(w, child, uses64Bit);
    writeNullRecord(w, uses64Bit);
  }

  const endOffset = w.length;
  patchOffsetField(w, endOffsetPos, endOffset, uses64Bit);
  patchOffsetField(w, numPropsPos, props.length, uses64Bit);
  patchOffsetField(w, propListLenPos, propListLen, uses64Bit);
  void offsetFieldSize;
}

function patchOffsetField(w: ByteWriter, pos: number, value: number, uses64Bit: boolean): void {
  if (uses64Bit) w.patchU64(pos, value);
  else w.patchU32(pos, value);
}

function writeNullRecord(w: ByteWriter, uses64Bit: boolean): void {
  const size = uses64Bit ? 25 : 13;
  w.bytesRaw(new Array(size).fill(0));
}

const MAGIC_TEXT = "Kaydara FBX Binary  ";

export interface BuildFBXOptions {
  version?: number;
  nodes: FixtureNode[];
  /** Overrides the 23-byte magic entirely, for magic-validation tests. */
  magicOverride?: Uint8Array;
  /** Skips writing the top-level null-record terminator, for truncation tests. */
  omitTopLevelTerminator?: boolean;
}

export function buildFBXBinary(options: BuildFBXOptions): ArrayBuffer {
  const version = options.version ?? 7400;
  const uses64Bit = version >= 7500;
  const w = new ByteWriter();

  if (options.magicOverride) {
    w.bytesRaw(options.magicOverride);
  } else {
    const magicBytes = new Uint8Array([...MAGIC_TEXT.split("").map((c) => c.charCodeAt(0)), 0x00, 0x1a, 0x00]);
    w.bytesRaw(magicBytes);
  }
  w.u32(version);

  for (const node of options.nodes) writeNode(w, node, uses64Bit);
  if (!options.omitTopLevelTerminator) writeNullRecord(w, uses64Bit);

  return w.toArrayBuffer();
}

/** Builds a plausible ASCII FBX file's opening bytes — for ASCII-rejection tests. */
export function buildAsciiFBX(): ArrayBuffer {
  const text = "; FBX 7.4.0 project file\n; ----------------------------------------------------\n\nFBXHeaderExtension:  {\n";
  return new TextEncoder().encode(text).buffer;
}

export function truncateBuffer(buffer: ArrayBuffer, length: number): ArrayBuffer {
  return buffer.slice(0, length);
}

/** An "Objects" child node's own record name is its FBX class; its first three properties are always [ObjectID, "Name\x00\x01Class", Subclass] by convention. */
export function objectNode(fbxClass: string, id: bigint, name: string, subclass: string, extraChildren: FixtureNode[] = []): FixtureNode {
  return {
    name: fbxClass,
    properties: [
      { type: "L", value: id },
      { type: "S", value: `${name} ${fbxClass}` },
      { type: "S", value: subclass },
    ],
    children: extraChildren,
  };
}

export function objectsSection(objects: FixtureNode[]): FixtureNode {
  return { name: "Objects", children: objects };
}

export function ooConnection(childId: bigint, parentId: bigint): FixtureNode {
  return { name: "C", properties: [{ type: "S", value: "OO" }, { type: "L", value: childId }, { type: "L", value: parentId }] };
}

export function opConnection(childId: bigint, parentId: bigint, propertyName: string): FixtureNode {
  return {
    name: "C",
    properties: [{ type: "S", value: "OP" }, { type: "L", value: childId }, { type: "L", value: parentId }, { type: "S", value: propertyName }],
  };
}

export function connectionsSection(connections: FixtureNode[]): FixtureNode {
  return { name: "Connections", children: connections };
}

/** A "P" property node inside a Properties70 block: [Name, Type, SubType, Flags, ...values]. */
export function p70(name: string, type: string, subtype: string, flags: string, values: FixtureProperty[]): FixtureNode {
  return { name: "P", properties: [{ type: "S", value: name }, { type: "S", value: type }, { type: "S", value: subtype }, { type: "S", value: flags }, ...values] };
}

export function properties70(entries: FixtureNode[]): FixtureNode {
  return { name: "Properties70", children: entries };
}

export function d3(x: number, y: number, z: number): FixtureProperty[] {
  return [{ type: "D", value: x }, { type: "D", value: y }, { type: "D", value: z }];
}

export function globalSettingsNode(entries: FixtureNode[]): FixtureNode {
  return { name: "GlobalSettings", children: [properties70(entries)] };
}

export function verticesNode(coords: number[]): FixtureNode {
  return { name: "Vertices", properties: [{ type: "d", value: coords }] };
}

export function polygonVertexIndexNode(raw: number[]): FixtureNode {
  return { name: "PolygonVertexIndex", properties: [{ type: "i", value: raw }] };
}

export function geometryNode(id: bigint, name: string, coords: number[], polygonIndices: number[], extraChildren: FixtureNode[] = []): FixtureNode {
  return objectNode("Geometry", id, name, "Mesh", [verticesNode(coords), polygonVertexIndexNode(polygonIndices), ...extraChildren]);
}

export function mappingRefNodes(mapping: string, reference: string): FixtureNode[] {
  return [
    { name: "MappingInformationType", properties: [{ type: "S", value: mapping }] },
    { name: "ReferenceInformationType", properties: [{ type: "S", value: reference }] },
  ];
}

export function layerElementNode(
  layerName: string,
  mapping: string,
  reference: string,
  valueChildName: string,
  values: number[],
  indexChildName?: string,
  indices?: number[],
): FixtureNode {
  const children: FixtureNode[] = [...mappingRefNodes(mapping, reference), { name: valueChildName, properties: [{ type: "d", value: values }] }];
  if (indexChildName && indices) children.push({ name: indexChildName, properties: [{ type: "i", value: indices }] });
  return { name: layerName, properties: [{ type: "I", value: 0 }], children };
}

export function materialNode(id: bigint, name: string, shadingModel: string, properties70Entries: FixtureNode[]): FixtureNode {
  return objectNode("Material", id, name, "", [{ name: "ShadingModel", properties: [{ type: "S", value: shadingModel }] }, properties70(properties70Entries)]);
}

export function videoNode(id: bigint, name: string, content: Uint8Array | null, relativeFilename?: string): FixtureNode {
  const children: FixtureNode[] = [];
  if (content) children.push({ name: "Content", properties: [{ type: "R", value: content }] });
  if (relativeFilename) children.push({ name: "RelativeFilename", properties: [{ type: "S", value: relativeFilename }] });
  return objectNode("Video", id, name, "Clip", children);
}

export function textureNode(id: bigint, name: string): FixtureNode {
  return objectNode("Texture", id, name, "");
}

export function layerElementMaterialNode(mapping: string, reference: string, materialIndices: number[]): FixtureNode {
  return {
    name: "LayerElementMaterial",
    properties: [{ type: "I", value: 0 }],
    children: [...mappingRefNodes(mapping, reference), { name: "Materials", properties: [{ type: "i", value: materialIndices }] }],
  };
}

export function expectFBXError(fn: () => void, code: FBXErrorCode): void {
  try {
    fn();
    expect.fail(`Expected FBXParseException(${code}) but no error was thrown`);
  } catch (error) {
    if (!(error instanceof FBXParseException)) throw error;
    expect(error.code).toBe(code);
  }
}
