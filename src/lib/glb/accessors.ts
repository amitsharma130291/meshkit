/**
 * Buffer-view resolution and accessor decoding. Every byte range here is
 * validated against the actual embedded-BIN-chunk length before a
 * `DataView` read ever touches it — declared `byteLength`/`count`/`stride`
 * values are treated as untrusted input, exactly like 3MF's ZIP
 * central-directory metadata is validated before any decompression.
 */
import { glbError } from "./errors";
import type { GLBLimits, GLTFDocument } from "./types";

const COMPONENT_BYTE_SIZES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const UNSIGNED_INTEGER_COMPONENT_TYPES: ReadonlySet<number> = new Set([5121, 5123, 5125]);

const TYPE_COMPONENT_COUNTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

interface ResolvedBufferView {
  data: Uint8Array;
  byteStride?: number;
}

/** Resolves and bounds-checks one `bufferViews[index]` against the embedded BIN chunk. Never reads past `bin`'s own length. */
export function resolveBufferView(doc: GLTFDocument, index: number, bin: Uint8Array | null): ResolvedBufferView {
  const bufferView = doc.bufferViews[index];
  if (!bufferView) throw glbError("GLB_BUFFER_VIEW_INVALID");
  if (bufferView.extensions?.EXT_meshopt_compression !== undefined) {
    throw glbError("GLB_MESHOPT_UNSUPPORTED");
  }

  const buffer = doc.buffers[bufferView.buffer];
  if (!buffer) throw glbError("GLB_BUFFER_INVALID");
  if (buffer.uri !== undefined) throw glbError("GLB_EXTERNAL_BUFFER_UNSUPPORTED");
  if (bufferView.buffer !== 0) {
    // Only buffer 0 (the GLB's own embedded BIN chunk) is meaningful without a URI.
    throw glbError("GLB_BUFFER_INVALID");
  }
  if (!bin) throw glbError("GLB_BIN_CHUNK_MISSING");
  if (buffer.byteLength > bin.byteLength) throw glbError("GLB_BUFFER_INVALID");

  const end = bufferView.byteOffset + bufferView.byteLength;
  if (end > buffer.byteLength || end > bin.byteLength) {
    throw glbError("GLB_BUFFER_VIEW_INVALID");
  }

  if (bufferView.byteStride !== undefined) {
    if (bufferView.byteStride < 4 || bufferView.byteStride > 252 || bufferView.byteStride % 4 !== 0) {
      throw glbError("GLB_BUFFER_VIEW_INVALID");
    }
  }

  return { data: bin.subarray(bufferView.byteOffset, end), byteStride: bufferView.byteStride };
}

function readComponent(view: DataView, byteOffset: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(byteOffset);
    case 5121:
      return view.getUint8(byteOffset);
    case 5122:
      return view.getInt16(byteOffset, true);
    case 5123:
      return view.getUint16(byteOffset, true);
    case 5125:
      return view.getUint32(byteOffset, true);
    case 5126:
      return view.getFloat32(byteOffset, true);
    default:
      throw glbError("GLB_ACCESSOR_TYPE_UNSUPPORTED");
  }
}

export interface RawAccessorData {
  /** Flat, `count * numComponents` — one entry per scalar component, in accessor element order. */
  values: Float64Array;
  count: number;
  numComponents: number;
}

/**
 * Decodes an accessor's raw numeric components, applying buffer-view
 * stride (interleaved or tightly packed) and any sparse override. This is
 * the single low-level reader every higher-level accessor function
 * (positions, indices) builds on, so byte-layout/sparse logic exists in
 * exactly one place.
 */
export function readAccessorRaw(doc: GLTFDocument, accessorIndex: number, bin: Uint8Array | null, limits: GLBLimits): RawAccessorData {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor) throw glbError("GLB_ACCESSOR_INVALID");

  const numComponents = TYPE_COMPONENT_COUNTS[accessor.type];
  if (!numComponents) throw glbError("GLB_ACCESSOR_TYPE_UNSUPPORTED");
  const componentSize = COMPONENT_BYTE_SIZES[accessor.componentType];
  if (!componentSize) throw glbError("GLB_ACCESSOR_TYPE_UNSUPPORTED");
  if (accessor.count > limits.maxAccessorElements) throw glbError("GLB_COMPLEXITY_LIMIT");

  const elementSize = numComponents * componentSize;
  const values = new Float64Array(accessor.count * numComponents);

  if (accessor.bufferView !== undefined) {
    const view = resolveBufferView(doc, accessor.bufferView, bin);
    const stride = view.byteStride ?? elementSize;
    if (stride < elementSize) throw glbError("GLB_BUFFER_VIEW_INVALID"); // stride smaller than one element can't hold it

    if (accessor.byteOffset % componentSize !== 0) throw glbError("GLB_ACCESSOR_INVALID"); // alignment

    if (accessor.count > 0) {
      const lastElementEnd = accessor.byteOffset + (accessor.count - 1) * stride + elementSize;
      if (lastElementEnd > view.data.byteLength) throw glbError("GLB_ACCESSOR_OUT_OF_BOUNDS");
    }

    const dataView = new DataView(view.data.buffer, view.data.byteOffset, view.data.byteLength);
    for (let e = 0; e < accessor.count; e++) {
      const elementStart = accessor.byteOffset + e * stride;
      for (let c = 0; c < numComponents; c++) {
        values[e * numComponents + c] = readComponent(dataView, elementStart + c * componentSize, accessor.componentType);
      }
    }
  }
  // else: accessor.bufferView is undefined — per spec, the accessor MUST be
  // treated as all-zero unless a sparse override applies. `values` is
  // already zero-filled by `new Float64Array(...)`.

  if (accessor.sparse) {
    applySparse(doc, accessor.count, accessor.componentType, accessor.sparse, values, numComponents, componentSize, bin, limits);
  }

  return { values, count: accessor.count, numComponents };
}

function applySparse(
  doc: GLTFDocument,
  accessorCount: number,
  accessorComponentType: number,
  sparse: NonNullable<GLTFDocument["accessors"][number]["sparse"]>,
  values: Float64Array,
  numComponents: number,
  componentSize: number,
  bin: Uint8Array | null,
  limits: GLBLimits,
): void {
  if (sparse.count === 0) return;
  if (sparse.count > accessorCount || sparse.count > limits.maxAccessorElements) {
    throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
  }

  const indexComponentSize = COMPONENT_BYTE_SIZES[sparse.indices.componentType];
  if (!indexComponentSize || !UNSIGNED_INTEGER_COMPONENT_TYPES.has(sparse.indices.componentType)) {
    throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
  }

  const indicesView = resolveBufferView(doc, sparse.indices.bufferView, bin);
  const indicesEnd = sparse.indices.byteOffset + sparse.count * indexComponentSize;
  if (indicesEnd > indicesView.data.byteLength) throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
  const indicesDataView = new DataView(indicesView.data.buffer, indicesView.data.byteOffset, indicesView.data.byteLength);

  const sparseIndices = new Uint32Array(sparse.count);
  const seen = new Set<number>();
  for (let i = 0; i < sparse.count; i++) {
    const idx = readComponent(indicesDataView, sparse.indices.byteOffset + i * indexComponentSize, sparse.indices.componentType);
    if (!Number.isInteger(idx) || idx < 0 || idx >= accessorCount) throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
    if (seen.has(idx)) throw glbError("GLB_SPARSE_ACCESSOR_INVALID"); // duplicate override target — ambiguous
    seen.add(idx);
    sparseIndices[i] = idx;
  }

  const elementSize = numComponents * componentSize;
  const valuesView = resolveBufferView(doc, sparse.values.bufferView, bin);
  const valuesEnd = sparse.values.byteOffset + sparse.count * elementSize;
  if (valuesEnd > valuesView.data.byteLength) throw glbError("GLB_SPARSE_ACCESSOR_INVALID");
  const valuesDataView = new DataView(valuesView.data.buffer, valuesView.data.byteOffset, valuesView.data.byteLength);

  for (let i = 0; i < sparse.count; i++) {
    const target = sparseIndices[i];
    const sourceStart = sparse.values.byteOffset + i * elementSize;
    for (let c = 0; c < numComponents; c++) {
      values[target * numComponents + c] = readComponent(valuesDataView, sourceStart + c * componentSize, accessorComponentType);
    }
  }
}

/** POSITION accessors: requires floating-point VEC3. `KHR_mesh_quantization`'s normalized/integer position encodings are not implemented — see docs/ARCHITECTURE.md. */
export function readPositionAccessor(doc: GLTFDocument, accessorIndex: number, bin: Uint8Array | null, limits: GLBLimits): Float32Array {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor) throw glbError("GLB_ACCESSOR_INVALID");
  if (accessor.type !== "VEC3" || accessor.componentType !== 5126) {
    throw glbError("GLB_ACCESSOR_TYPE_UNSUPPORTED");
  }
  const raw = readAccessorRaw(doc, accessorIndex, bin, limits);
  const positions = new Float32Array(raw.values.length);
  for (let i = 0; i < raw.values.length; i++) {
    if (!Number.isFinite(raw.values[i])) throw glbError("GLB_ACCESSOR_INVALID");
    positions[i] = raw.values[i];
  }
  return positions;
}

/** Index accessors: requires SCALAR with an unsigned integer component type — signed and float index accessors are rejected outright. */
export function readIndexAccessor(doc: GLTFDocument, accessorIndex: number, bin: Uint8Array | null, limits: GLBLimits): Uint32Array {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor) throw glbError("GLB_ACCESSOR_INVALID");
  if (accessor.type !== "SCALAR" || !UNSIGNED_INTEGER_COMPONENT_TYPES.has(accessor.componentType)) {
    throw glbError("GLB_INDEX_INVALID");
  }
  const raw = readAccessorRaw(doc, accessorIndex, bin, limits);
  const indices = new Uint32Array(raw.values.length);
  for (let i = 0; i < raw.values.length; i++) {
    const v = raw.values[i];
    if (!Number.isInteger(v) || v < 0) throw glbError("GLB_INDEX_INVALID");
    indices[i] = v;
  }
  return indices;
}
