/**
 * Lexical tokenizer for one already-decoded G-code line. Purely lexical —
 * it recognizes the letter/number word grammar, line numbers, checksums
 * and comments, but never interprets what a command or axis MEANS
 * (that's `modal-state.ts`/`linear-moves.ts`'s job). Never throws on
 * malformed input — a stray or malformed token is counted and skipped so
 * the rest of the line (and file) keeps parsing.
 */

export const DEFAULT_MAX_COMMENT_LENGTH = 500;

export type CommentKind = "semicolon" | "parenthetical";

export interface GCodeComment {
  kind: CommentKind;
  text: string;
  truncated: boolean;
}

export interface GCodeWord {
  letter: string;
  /** The raw numeric text as it appeared, for diagnostics only — never a full source line. */
  raw: string;
  /** Parsed value; `null` when the token couldn't be parsed as a number at all. */
  value: number | null;
  /** False when `value` is `null`, or parsed but non-finite (e.g. an overflowing exponent). */
  finite: boolean;
}

export interface TokenizedLine {
  lineNumber: number | null;
  checksum: number | null;
  words: GCodeWord[];
  comment: GCodeComment | null;
  malformedTokenCount: number;
  /** True when the line has no words and no line number (comment-only and empty lines both qualify). */
  isBlank: boolean;
}

export interface TokenizeLineOptions {
  maxCommentLength?: number;
}

function isLetter(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Consumes the maximal span starting at `i` that fits G-code's numeric grammar: optional sign, digits, at most one decimal point, optional exponent. Returns the end index (exclusive). */
function consumeNumberSpan(s: string, i: number): number {
  const n = s.length;
  if (i < n && (s[i] === "+" || s[i] === "-")) i++;
  let sawDigit = false;
  let sawDot = false;
  let sawExp = false;
  while (i < n) {
    const c = s[i];
    if (isDigit(c)) {
      sawDigit = true;
      i++;
      continue;
    }
    if (c === "." && !sawDot && !sawExp) {
      sawDot = true;
      i++;
      continue;
    }
    if ((c === "e" || c === "E") && !sawExp && sawDigit) {
      let j = i + 1;
      if (j < n && (s[j] === "+" || s[j] === "-")) j++;
      if (j < n && isDigit(s[j])) {
        sawExp = true;
        i = j;
        continue;
      }
      break;
    }
    break;
  }
  return i;
}

function parseGCodeNumber(raw: string): { value: number | null; finite: boolean } {
  if (raw.length === 0) return { value: null, finite: false };
  const n = Number(raw);
  if (Number.isNaN(n)) return { value: null, finite: false };
  if (!Number.isFinite(n)) return { value: n, finite: false };
  return { value: n, finite: true };
}

function boundComment(text: string, kind: CommentKind, maxLength: number): GCodeComment {
  if (text.length > maxLength) return { kind, text: text.slice(0, maxLength), truncated: true };
  return { kind, text, truncated: false };
}

export function tokenizeLine(line: string, options: TokenizeLineOptions = {}): TokenizedLine {
  const maxCommentLength = options.maxCommentLength ?? DEFAULT_MAX_COMMENT_LENGTH;
  const n = line.length;
  let i = 0;
  const words: GCodeWord[] = [];
  let lineNumber: number | null = null;
  let checksum: number | null = null;
  let comment: GCodeComment | null = null;
  let malformedTokenCount = 0;
  let sawFirstToken = false;

  while (i < n) {
    const ch = line[i];

    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    if (ch === ";") {
      const text = line.slice(i + 1);
      comment = boundComment(text, "semicolon", maxCommentLength);
      break;
    }

    if (ch === "(") {
      const close = line.indexOf(")", i + 1);
      const end = close === -1 ? n : close;
      const text = line.slice(i + 1, end);
      if (comment === null) comment = boundComment(text, "parenthetical", maxCommentLength);
      i = close === -1 ? n : close + 1;
      continue;
    }

    if (ch === "*") {
      i++;
      const start = i;
      i = consumeNumberSpan(line, i);
      const raw = line.slice(start, i);
      const parsed = parseGCodeNumber(raw);
      if (parsed.finite) checksum = Math.trunc(parsed.value!);
      else malformedTokenCount++;
      continue;
    }

    if (isLetter(ch)) {
      const letter = ch.toUpperCase();
      i++;
      const start = i;
      i = consumeNumberSpan(line, i);
      const raw = line.slice(start, i);
      const parsed = parseGCodeNumber(raw);
      if (parsed.value === null) malformedTokenCount++;

      if (letter === "N" && !sawFirstToken) {
        lineNumber = parsed.finite ? Math.trunc(parsed.value!) : null;
        sawFirstToken = true;
        continue;
      }

      sawFirstToken = true;
      words.push({ letter, raw, value: parsed.value, finite: parsed.finite });
      continue;
    }

    // Stray/unexpected character — never fatal, just counted and skipped.
    malformedTokenCount++;
    sawFirstToken = true;
    i++;
  }

  const isBlank = words.length === 0 && lineNumber === null;
  return { lineNumber, checksum, words, comment, malformedTokenCount, isBlank };
}
