/**
 * Binary FBX's own node-tree shape, kept deliberately close to the format
 * itself (not a "document object model" yet — see document.ts for the
 * interpreted view). A binary FBX file is nothing but a flat 27-byte
 * header followed by a tree of these node records; every higher layer
 * (document.ts, connections.ts, geometry.ts, ...) is built entirely out
 * of walking this tree, never a second pass over raw bytes.
 */

/** The 13 property type codes a binary FBX property list can contain — six scalars, five typed-array kinds, plus string and raw binary. */
export type FBXPropertyTypeCode = "Y" | "C" | "I" | "F" | "D" | "L" | "f" | "d" | "l" | "i" | "b" | "S" | "R";

export type FBXProperty =
  | { type: "Y"; value: number } // int16
  | { type: "C"; value: boolean } // 1-byte bool
  | { type: "I"; value: number } // int32
  | { type: "F"; value: number } // float32
  | { type: "D"; value: number } // float64
  | { type: "L"; value: bigint } // int64 — kept as bigint; FBX object IDs need exact 64-bit identity, not float precision
  | { type: "f"; value: Float32Array }
  | { type: "d"; value: Float64Array }
  | { type: "l"; value: BigInt64Array }
  | { type: "i"; value: Int32Array }
  | { type: "b"; value: Uint8Array } // one byte per element, 0/nonzero
  | { type: "S"; value: string }
  | { type: "R"; value: Uint8Array };

export interface FBXNode {
  name: string;
  properties: FBXProperty[];
  children: FBXNode[];
}

/** The parsed node tree plus the file-level facts everything downstream needs. */
export interface FBXBinaryDocument {
  version: number;
  /** True for FBX 7500+, where node-record offset/length fields are 8 bytes instead of 4. Purely a framing detail — never exposed past binary-parser.ts other than for display. */
  uses64BitRecords: boolean;
  /** Top-level nodes (FBXHeaderExtension, GlobalSettings, Definitions, Objects, Connections, ...), in file order. */
  nodes: FBXNode[];
}

export interface FBXLimits {
  maxFileBytes: number;
  maxNodeCount: number;
  maxTreeDepth: number;
  maxPropertiesPerNode: number;
  maxStringBytes: number;
  maxRawPropertyBytes: number;
  /** Ceiling on a compressed array property's on-disk (still-compressed) byte length, checked before attempting decompression. */
  maxCompressedArrayBytes: number;
  /** Ceiling on ArrayLength * elementSize (the decompressed/raw byte length a typed-array property may declare), checked before allocating its output buffer. */
  maxDecompressedArrayBytes: number;
  maxObjectCount: number;
  maxConnectionCount: number;
  maxModelCount: number;
  maxGeometryCount: number;
  maxHierarchyDepth: number;
  maxControlPointsPerGeometry: number;
  maxPolygonVertexCount: number;
  maxPolygonsPerGeometry: number;
  maxTriangles: number;
  maxMaterialCount: number;
  maxTextureCount: number;
  maxImageCount: number;
  maxImageBytes: number;
  maxMetadataBytes: number;
  maxNameLength: number;
  /** Total bytes across every transferable buffer handed back to the main thread. */
  maxOutputBytes: number;
}

export const DEFAULT_FBX_LIMITS: FBXLimits = {
  maxFileBytes: 150 * 1024 * 1024,
  maxNodeCount: 2_000_000,
  maxTreeDepth: 128,
  maxPropertiesPerNode: 4096,
  maxStringBytes: 1 * 1024 * 1024,
  maxRawPropertyBytes: 64 * 1024 * 1024,
  maxCompressedArrayBytes: 64 * 1024 * 1024,
  maxDecompressedArrayBytes: 256 * 1024 * 1024,
  maxObjectCount: 500_000,
  maxConnectionCount: 2_000_000,
  maxModelCount: 200_000,
  maxGeometryCount: 100_000,
  maxHierarchyDepth: 128,
  maxControlPointsPerGeometry: 5_000_000,
  maxPolygonVertexCount: 4096,
  maxPolygonsPerGeometry: 5_000_000,
  maxTriangles: 5_000_000,
  maxMaterialCount: 20_000,
  maxTextureCount: 20_000,
  maxImageCount: 2_000,
  maxImageBytes: 32 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxNameLength: 200,
  maxOutputBytes: 512 * 1024 * 1024,
};

export const FBX_MIN_SUPPORTED_VERSION = 7000;
export const FBX_MAX_SUPPORTED_VERSION = 7700;
/** The node-record layout switches from 32-bit to 64-bit offset/length fields at this version. */
export const FBX_64BIT_RECORD_VERSION = 7500;
