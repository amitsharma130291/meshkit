/**
 * Text serialization for indexed OBJ output — the write-side counterpart
 * to `src/lib/obj/parser.ts` (which only ever reads OBJ). Builds the
 * whole document as an array of line strings (never `+=` concatenation,
 * which risks quadratic behavior for very large meshes) and joins once,
 * so this stays linear in output size regardless of triangle count.
 */
import { objError } from "./errors";
import { formatFloat32 } from "./number-format";
import { yieldIfCancelled } from "../cancellation";
import type { DeduplicatedGeometry } from "./deduplicate";

export interface OBJSerializeLimits {
  maxFaces: number;
  /** Checked incrementally while building line-by-line, before the final join/encode — never lets a massive final string get allocated. */
  maxOutputBytes: number;
}

export type OBJSerializeStage = "writing-vertices" | "writing-normals" | "writing-faces" | "encoding-obj";

export interface OBJSerializeOptions {
  isCancelled?: () => boolean;
  yieldEvery?: number;
  /** Invoked right before each sub-phase starts — lets a caller (the worker) report honest, fine-grained progress without this function needing to know anything about the worker protocol. */
  onStage?: (stage: OBJSerializeStage) => void;
}

export interface OBJSerializeResult {
  bytes: Uint8Array;
  uniqueVertexCount: number;
  faceCount: number;
  normalCount: number;
  outputByteLength: number;
}

const OBJECT_NAME = "MeshWrench_Converted";
const DEFAULT_YIELD_EVERY = 100_000;
/** Defensive ceiling well beyond any realistic `maxUniqueVertices`/`maxFaces` — guards the one-based `+1` index arithmetic against overflow. */
const MAX_OBJ_INDEX = 2 ** 31 - 1;

/**
 * Serializes already-deduplicated geometry plus one geometric normal per
 * triangle into a complete, valid UTF-8 OBJ document:
 *
 *   # Generated locally by MeshWrench
 *   o MeshWrench_Converted
 *   s off
 *   v ...                  (one per unique vertex)
 *   vn ...                 (one per triangle)
 *   f a//n b//n c//n        (one-based; vertex//normal, no texture coordinate)
 *
 * Never writes the source filename, any STL header text, `mtllib` or
 * `usemtl` — this converter never invents materials, and the object name
 * is a single fixed, sanitized constant rather than anything derived from
 * user input.
 */
export async function serializeOBJ(
  geometry: DeduplicatedGeometry,
  faceNormals: Float32Array,
  limits: OBJSerializeLimits,
  options: OBJSerializeOptions = {},
): Promise<OBJSerializeResult> {
  const triangleCount = faceNormals.length / 3;
  const uniqueVertexCount = geometry.uniqueVertexCount;

  if (uniqueVertexCount === 0 || triangleCount === 0) {
    throw objError("OBJ_NO_OUTPUT_GEOMETRY");
  }
  if (triangleCount > limits.maxFaces) {
    throw objError("OBJ_FACE_LIMIT_EXCEEDED");
  }
  if (uniqueVertexCount > MAX_OBJ_INDEX || triangleCount > MAX_OBJ_INDEX) {
    throw objError("OBJ_INDEX_OVERFLOW");
  }

  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const lines: string[] = ["# Generated locally by MeshWrench", `o ${OBJECT_NAME}`, "s off"];
  let estimatedBytes = lines.reduce((sum, line) => sum + line.length + 1, 0);

  const addLine = (line: string): void => {
    estimatedBytes += line.length + 1;
    if (estimatedBytes > limits.maxOutputBytes) throw objError("OBJ_OUTPUT_TOO_LARGE");
    lines.push(line);
  };

  options.onStage?.("writing-vertices");
  for (let v = 0; v < uniqueVertexCount; v++) {
    await yieldIfCancelled(v, yieldEvery, options.isCancelled);
    const base = v * 3;
    addLine(`v ${formatFloat32(geometry.vertices[base])} ${formatFloat32(geometry.vertices[base + 1])} ${formatFloat32(geometry.vertices[base + 2])}`);
  }

  options.onStage?.("writing-normals");
  for (let t = 0; t < triangleCount; t++) {
    await yieldIfCancelled(t, yieldEvery, options.isCancelled);
    const base = t * 3;
    addLine(`vn ${formatFloat32(faceNormals[base])} ${formatFloat32(faceNormals[base + 1])} ${formatFloat32(faceNormals[base + 2])}`);
  }

  options.onStage?.("writing-faces");
  for (let t = 0; t < triangleCount; t++) {
    await yieldIfCancelled(t, yieldEvery, options.isCancelled);
    const a = geometry.triangleVertexIndices[t * 3] + 1;
    const b = geometry.triangleVertexIndices[t * 3 + 1] + 1;
    const c = geometry.triangleVertexIndices[t * 3 + 2] + 1;
    const normalIndex = t + 1;
    addLine(`f ${a}//${normalIndex} ${b}//${normalIndex} ${c}//${normalIndex}`);
  }

  options.onStage?.("encoding-obj");
  const text = lines.join("\n") + "\n"; // LF endings, trailing newline

  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(text);
  } catch {
    throw objError("OBJ_TEXT_ENCODING_FAILED");
  }

  return {
    bytes,
    uniqueVertexCount,
    faceCount: triangleCount,
    normalCount: triangleCount,
    outputByteLength: bytes.byteLength,
  };
}
