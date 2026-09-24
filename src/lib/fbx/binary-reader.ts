/**
 * A bounds-checked cursor over the file's `ArrayBuffer`. Every read method
 * checks the requested byte count against what's actually left before
 * touching `DataView`, and advances `offset` only after a successful read
 * — so a caller can never observe a partially-advanced cursor after a
 * thrown error. This is the single choke point every other FBX module
 * reads bytes through; nothing else in `src/lib/fbx/` touches the raw
 * `ArrayBuffer`/`DataView` directly.
 */
import { fbxError } from "./errors";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class BinaryCursor {
  readonly byteLength: number;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  offset: number;

  constructor(buffer: ArrayBuffer, offset = 0) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.byteLength = buffer.byteLength;
    this.offset = offset;
  }

  get remaining(): number {
    return this.byteLength - this.offset;
  }

  /** Throws unless at least `n` bytes remain — call before any multi-byte read whose failure should be reported as truncation, not a generic error. */
  private ensure(n: number): void {
    if (n < 0 || this.offset + n > this.byteLength) throw fbxError("FBX_NODE_TRUNCATED");
  }

  readUint8(): number {
    this.ensure(1);
    const v = this.bytes[this.offset];
    this.offset += 1;
    return v;
  }

  readInt16LE(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readUint32LE(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readInt32LE(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readFloat32LE(): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readFloat64LE(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readBigInt64LE(): bigint {
    this.ensure(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readBigUint64LE(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** A 64-bit unsigned value that's about to be used as a byte offset/length/count — rejects anything exceeding `Number.MAX_SAFE_INTEGER` before ever converting it, per this phase's own "reject unsafe 64-bit values" requirement. */
  readSafeUint64LE(): number {
    const raw = this.readBigUint64LE();
    if (raw > MAX_SAFE_BIGINT) throw fbxError("FBX_UNSAFE_INTEGER");
    return Number(raw);
  }

  readBytes(n: number): Uint8Array {
    this.ensure(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  readString(byteLength: number, maxBytes: number): string {
    if (byteLength > maxBytes) throw fbxError("FBX_STRING_TOO_LONG");
    const raw = this.readBytes(byteLength);
    return new TextDecoder("utf-8", { fatal: false }).decode(raw);
  }

  skip(n: number): void {
    this.ensure(n);
    this.offset += n;
  }

  /** True when at least `n` bytes remain — used to distinguish "legitimate end of the node list" from "truncated mid-record" without throwing. */
  hasRemaining(n: number): boolean {
    return this.remaining >= n;
  }
}
