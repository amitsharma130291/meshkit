/**
 * Hand-rolled ZIP container reader scoped to exactly what OPC/3MF packages
 * need. Every safety check the project requires (encrypted entries,
 * unsupported compression methods, path traversal, entry-count/size/ratio
 * ceilings, ZIP64 rejection) runs against the ZIP **central directory**
 * before any byte is decompressed — `fflate`'s `inflateSync` is used only
 * for the DEFLATE algorithm itself on the one or two entries actually
 * needed (never for parsing the container format, and never eagerly for
 * every entry in the archive).
 */
import { inflateSync } from "fflate";
import { threeMFError } from "./errors";
import type { ThreeMFLimits } from "./types";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const MAX_EOCD_COMMENT_BYTES = 65535;
const ENCRYPTION_FLAG_BIT = 0x0001;

interface ZipCentralEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ThreeMFPackage {
  /** Normalized entry names present in the archive (for relationship/model-path resolution). */
  readonly entryNames: ReadonlySet<string>;
  /** Decompresses one entry on demand. Throws if the name isn't present. */
  readEntry(name: string): Uint8Array;
}

export function openThreeMFPackage(buffer: ArrayBuffer, limits: ThreeMFLimits): ThreeMFPackage {
  if (buffer.byteLength === 0) {
    throw threeMFError("THREEMF_INVALID_PACKAGE");
  }
  if (buffer.byteLength > limits.maxCompressedPackageBytes) {
    throw threeMFError("THREEMF_PACKAGE_TOO_LARGE");
  }

  const bytes = new Uint8Array(buffer);
  const entries = readCentralDirectory(bytes, limits);

  const byName = new Map<string, ZipCentralEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      // Ambiguous: OPC requires unique part names, and two entries claiming
      // the same path make "which one is the real model?" undecidable.
      throw threeMFError("THREEMF_INVALID_PACKAGE");
    }
    byName.set(entry.name, entry);
  }

  return {
    entryNames: new Set(byName.keys()),
    readEntry(name: string): Uint8Array {
      const entry = byName.get(name);
      if (!entry) {
        throw threeMFError("THREEMF_MODEL_PART_MISSING");
      }
      return extractEntry(bytes, entry);
    },
  };
}

function readCentralDirectory(bytes: Uint8Array, limits: ThreeMFLimits): ZipCentralEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const totalEntries = readU16(bytes, eocdOffset + 10);
  const centralDirectorySize = readU32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readU32(bytes, eocdOffset + 16);

  if (totalEntries === ZIP64_SENTINEL_16 || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    // ZIP64 is required for archives beyond standard 32-bit limits — well
    // beyond anything a legitimate 3MF model needs, and beyond what this
    // reader supports.
    throw threeMFError("THREEMF_PACKAGE_TOO_LARGE");
  }
  if (totalEntries > limits.maxZipEntries) {
    throw threeMFError("THREEMF_ZIP_BOMB_SUSPECTED");
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw threeMFError("THREEMF_ZIP_CORRUPT");
  }

  const entries: ZipCentralEntry[] = [];
  let offset = centralDirectoryOffset;
  let totalDecompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > bytes.length || readU32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw threeMFError("THREEMF_ZIP_CORRUPT");
    }

    const generalPurposeFlag = readU16(bytes, offset + 8);
    const compressionMethod = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localHeaderOffset = readU32(bytes, offset + 42);

    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw threeMFError("THREEMF_PACKAGE_TOO_LARGE");
    }
    if ((generalPurposeFlag & ENCRYPTION_FLAG_BIT) !== 0) {
      throw threeMFError("THREEMF_ZIP_ENCRYPTED");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw threeMFError("THREEMF_ZIP_CORRUPT");
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw threeMFError("THREEMF_ZIP_CORRUPT");
    }
    if (uncompressedSize > limits.maxSingleEntryDecompressedBytes) {
      throw threeMFError("THREEMF_ZIP_BOMB_SUSPECTED");
    }
    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        throw threeMFError("THREEMF_ZIP_BOMB_SUSPECTED");
      }
    }
    totalDecompressed += uncompressedSize;
    if (totalDecompressed > limits.maxTotalDecompressedBytes) {
      throw threeMFError("THREEMF_ZIP_BOMB_SUSPECTED");
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw threeMFError("THREEMF_ZIP_CORRUPT");
    }
    const rawName = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, nameEnd));
    const name = normalizeEntryName(rawName);

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });

    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function extractEntry(bytes: Uint8Array, entry: ZipCentralEntry): Uint8Array {
  const headerOffset = entry.localHeaderOffset;
  if (headerOffset + 30 > bytes.length || readU32(bytes, headerOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw threeMFError("THREEMF_ZIP_CORRUPT");
  }
  const nameLength = readU16(bytes, headerOffset + 26);
  const extraLength = readU16(bytes, headerOffset + 28);
  const dataStart = headerOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw threeMFError("THREEMF_ZIP_CORRUPT");
  }
  const compressed = bytes.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      throw threeMFError("THREEMF_ZIP_CORRUPT");
    }
    return compressed.slice();
  }

  try {
    const output = inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
    if (output.length !== entry.uncompressedSize) {
      throw threeMFError("THREEMF_ZIP_BOMB_SUSPECTED");
    }
    return output;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "ThreeMFParseException") throw cause;
    throw threeMFError("THREEMF_ZIP_CORRUPT");
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 22 - MAX_EOCD_COMMENT_BYTES);
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw threeMFError("THREEMF_INVALID_PACKAGE");
}

function normalizeEntryName(rawName: string): string {
  if (rawName.length === 0 || rawName.includes("\0") || rawName.includes("\\")) {
    throw threeMFError("THREEMF_INVALID_PACKAGE");
  }
  if (rawName.startsWith("/") || /^[A-Za-z]:/.test(rawName)) {
    throw threeMFError("THREEMF_INVALID_PACKAGE");
  }
  const segments = rawName.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw threeMFError("THREEMF_INVALID_PACKAGE");
    }
  }
  return rawName;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
