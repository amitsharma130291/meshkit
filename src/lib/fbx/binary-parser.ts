/**
 * Parses the raw node-record tree out of a binary FBX file's bytes —
 * header validation (magic, explicit ASCII rejection, version range),
 * then every `FBXNode` (name, properties via property-decoder.ts,
 * children), governed entirely by each record's own declared `EndOffset`
 * rather than a second, independently-computed size. Nothing here
 * interprets what a node *means* (that's document.ts's job) — this module
 * only ever answers "what does the byte layout say."
 *
 * Deliberately iterative, not recursive: a work stack of open "read
 * children until offset reaches this target" frames stands in for what
 * would otherwise be one JS call frame per tree level, so a maliciously
 * (or accidentally) deep node tree fails via this module's own
 * `maxTreeDepth` ceiling — a controlled, safe error — rather than via an
 * uncontrolled native stack overflow.
 */
import { BinaryCursor } from "./binary-reader";
import { fbxError } from "./errors";
import { decodeProperty } from "./property-decoder";
import {
  FBX_64BIT_RECORD_VERSION,
  FBX_MAX_SUPPORTED_VERSION,
  FBX_MIN_SUPPORTED_VERSION,
  type FBXBinaryDocument,
  type FBXLimits,
  type FBXNode,
} from "./types";

const MAGIC_TEXT = "Kaydara FBX Binary  "; // 20 bytes, followed by 0x00 0x1A 0x00
const MAGIC_BYTES = new Uint8Array([...MAGIC_TEXT.split("").map((c) => c.charCodeAt(0)), 0x00, 0x1a, 0x00]);
const HEADER_BYTES = MAGIC_BYTES.length + 4; // + uint32 version
const ASCII_SNIFF_WINDOW = 256;

function isAsciiFBX(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, ASCII_SNIFF_WINDOW));
  if (bytes.length === 0) return false;
  for (const b of bytes) {
    const printable = b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e);
    if (!printable) return false;
  }
  return true;
}

interface Frame {
  /** The node whose children this frame is reading, or `null` for the implicit document root (which has no `EndOffset` of its own). */
  node: FBXNode | null;
  /** Byte offset every child record in this frame must collectively end at — read children until `cursor.offset === target`. `null` for the root frame, which instead stops at the top-level null record or a clean EOF. */
  target: number | null;
  depth: number;
}

interface RecordHeaderSizes {
  /** EndOffset + NumProperties + PropertyListLen + NameLen(1 byte) — also exactly the byte size of a null-record terminator, since a terminator is this same header with every numeric field zero and no name/properties following. */
  headerSize: number;
  readOffsetField: (cursor: BinaryCursor) => number;
}

function recordHeaderSizes(uses64Bit: boolean): RecordHeaderSizes {
  if (uses64Bit) {
    return { headerSize: 8 + 8 + 8 + 1, readOffsetField: (c) => c.readSafeUint64LE() };
  }
  return { headerSize: 4 + 4 + 4 + 1, readOffsetField: (c) => c.readUint32LE() };
}

export function parseFBXBinary(buffer: ArrayBuffer, limits: FBXLimits): FBXBinaryDocument {
  if (buffer.byteLength > limits.maxFileBytes) throw fbxError("FBX_FILE_TOO_LARGE");
  if (buffer.byteLength < HEADER_BYTES) {
    if (isAsciiFBX(buffer)) throw fbxError("FBX_ASCII_DETECTED");
    throw fbxError("FBX_HEADER_TRUNCATED");
  }

  const headerBytes = new Uint8Array(buffer, 0, MAGIC_BYTES.length);
  let magicMatches = true;
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (headerBytes[i] !== MAGIC_BYTES[i]) {
      magicMatches = false;
      break;
    }
  }
  if (!magicMatches) {
    if (isAsciiFBX(buffer)) throw fbxError("FBX_ASCII_DETECTED");
    throw fbxError("FBX_MAGIC_INVALID");
  }

  const cursor = new BinaryCursor(buffer, MAGIC_BYTES.length);
  const version = cursor.readUint32LE();
  if (version < FBX_MIN_SUPPORTED_VERSION || version > FBX_MAX_SUPPORTED_VERSION) {
    throw fbxError("FBX_VERSION_UNSUPPORTED");
  }
  const uses64BitRecords = version >= FBX_64BIT_RECORD_VERSION;
  const sizes = recordHeaderSizes(uses64BitRecords);

  const rootChildren: FBXNode[] = [];
  const stack: Frame[] = [{ node: null, target: null, depth: 0 }];
  let nodeCount = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const parentChildren = frame.node ? frame.node.children : rootChildren;

    if (frame.target !== null && cursor.offset === frame.target) {
      // This frame's children are exactly accounted for — done, no null record to read here (EndOffset already matched).
      stack.pop();
      continue;
    }

    if (frame.target === null) {
      // Root frame: decide null-record-vs-real-node-vs-clean-EOF by how many bytes are left.
      if (cursor.remaining === 0) {
        stack.pop();
        continue;
      }
      if (!cursor.hasRemaining(sizes.headerSize)) {
        throw fbxError("FBX_NODE_TRUNCATED");
      }
    }

    const recordStart = cursor.offset;
    const endOffset = sizes.readOffsetField(cursor);
    const numProperties = sizes.readOffsetField(cursor);
    const propertyListLen = sizes.readOffsetField(cursor);
    const nameLen = cursor.readUint8();

    if (endOffset === 0 && numProperties === 0 && propertyListLen === 0 && nameLen === 0) {
      // Null-record terminator.
      if (frame.target !== null && cursor.offset !== frame.target) {
        throw fbxError("FBX_OFFSET_INVALID");
      }
      stack.pop();
      continue;
    }

    const parentBound = frame.target ?? buffer.byteLength;
    if (endOffset <= recordStart || endOffset > parentBound) {
      throw fbxError("FBX_OFFSET_INVALID");
    }
    if (numProperties > limits.maxPropertiesPerNode) {
      throw fbxError("FBX_PROPERTY_COUNT_EXCEEDED");
    }

    const name = cursor.readString(nameLen, limits.maxNameLength);

    const propertyListStart = cursor.offset;
    const properties = [];
    for (let i = 0; i < numProperties; i++) {
      properties.push(decodeProperty(cursor, limits));
    }
    if (cursor.offset - propertyListStart !== propertyListLen) {
      throw fbxError("FBX_OFFSET_INVALID");
    }
    if (cursor.offset > endOffset) {
      throw fbxError("FBX_OFFSET_INVALID");
    }

    nodeCount++;
    if (nodeCount > limits.maxNodeCount) throw fbxError("FBX_NODE_COUNT_EXCEEDED");

    const node: FBXNode = { name, properties, children: [] };
    parentChildren.push(node);

    if (cursor.offset < endOffset) {
      const depth = frame.depth + 1;
      if (depth > limits.maxTreeDepth) throw fbxError("FBX_NODE_DEPTH_EXCEEDED");
      stack.push({ node, target: endOffset, depth });
    }
    // else: cursor.offset === endOffset exactly — a leaf node with no children section at all.
  }

  return { version, uses64BitRecords, nodes: rootChildren };
}
