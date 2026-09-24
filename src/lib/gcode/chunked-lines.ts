/**
 * Bounded, streaming line decoder for G-code files. Never buffers the
 * whole file as one string and never accumulates an unbounded array of
 * lines — the worker feeds it one bounded `File.slice()`/`Blob.stream()`
 * chunk at a time via `pushChunk()`, and calls `finish()` once at EOF.
 * Uses `TextDecoder`'s own `{ stream: true }` mode, which is the
 * browser-native mechanism for correctly resolving a multibyte UTF-8
 * sequence split across chunk boundaries — never reimplemented here.
 */

export const DEFAULT_MAX_LINE_LENGTH = 20_000;

export interface ChunkedLineDecoderOptions {
  /** A single decoded line longer than this is truncated and flagged, never buffered in full. */
  maxLineLength?: number;
}

export interface DecodedLine {
  text: string;
  /** True when this line exceeded `maxLineLength` and was cut short. */
  truncated: boolean;
}

export class ChunkedLineDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly maxLineLength: number;
  private pending = "";
  private firstChunk = true;
  /** True while discarding bytes of an already-truncated line until its next newline. */
  private skippingToNextLine = false;

  constructor(options: ChunkedLineDecoderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /** Current size of the internal partial-line buffer — bounded by `maxLineLength`, never by total bytes seen. */
  pendingBufferLength(): number {
    return this.pending.length;
  }

  pushChunk(bytes: Uint8Array): DecodedLine[] {
    let text = this.decoder.decode(bytes, { stream: true });
    if (this.firstChunk) {
      this.firstChunk = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.pending += text;
    return this.extractLines(false);
  }

  finish(): DecodedLine[] {
    const tail = this.decoder.decode();
    this.pending += tail;
    return this.extractLines(true);
  }

  /**
   * Walks `this.pending` with a single forward cursor and only ever
   * slices once per extracted line (from that fixed, unchanging string)
   * plus once more at the very end to trim the consumed prefix. The
   * previous version re-sliced the ENTIRE remaining `pending` off the
   * front on every single line (`pending = pending.slice(idx + 1)`,
   * repeated once per line). That looks O(1) per slice, but a
   * `TextDecoder`-sourced string re-sliced that many times in a row
   * chains into a deeply nested run of slices-of-slices — walking that
   * chain to read any character then costs O(chain depth), so touching
   * every extracted line's content (as `tokenizeLine` does) degraded to
   * O(linesPerChunk²) and turned large files (tens of thousands of short
   * lines per 256KB worker chunk) unusable. A cursor never re-slices an
   * already-sliced value, so this stays linear regardless of how many
   * lines one chunk contains.
   */
  private extractLines(final: boolean): DecodedLine[] {
    const out: DecodedLine[] = [];
    const text = this.pending;
    let start = 0;

    for (;;) {
      if (this.skippingToNextLine) {
        const nl = text.indexOf("\n", start);
        if (nl === -1) {
          start = text.length;
          break;
        }
        start = nl + 1;
        this.skippingToNextLine = false;
        continue;
      }

      const idx = text.indexOf("\n", start);

      // A line is only "too long" relative to its OWN length — never to how
      // much unrelated, already-complete text happens to be queued up
      // behind it in this chunk. So this checks the distance to the next
      // newline (once known), not `text.length - start`, which conflated
      // "one absurdly long line" with "many ordinary short lines batched
      // into one large chunk" and truncated the latter by mistake.
      if (idx !== -1 && idx - start > this.maxLineLength) {
        out.push({ text: flatten(text.slice(start, start + this.maxLineLength)), truncated: true });
        start = idx + 1;
        continue;
      }
      if (idx === -1 && text.length - start > this.maxLineLength) {
        out.push({ text: flatten(text.slice(start, start + this.maxLineLength)), truncated: true });
        start += this.maxLineLength;
        this.skippingToNextLine = true;
        continue;
      }

      if (idx === -1) break;
      let line = text.slice(start, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      out.push({ text: flatten(line), truncated: false });
      start = idx + 1;
    }

    if (final && !this.skippingToNextLine && start < text.length) {
      out.push({ text: flatten(text.slice(start)), truncated: false });
      start = text.length;
    }

    this.pending = text.slice(start);
    return out;
  }
}

/** Forces V8 to materialize an independent flat string instead of a view that still shares its (possibly large) parent — see `extractLines`'s own doc comment for why that sharing is the actual hazard. */
function flatten(s: string): string {
  return (" " + s).slice(1);
}
