/**
 * G-code line-checksum verification (the classic RepRap/Marlin XOR
 * checksum: the XOR of every character's char code from the start of the
 * line up to, but not including, the `*`). Reports valid/missing/
 * mismatched — it never rejects a file itself; `strict` vs. lenient
 * handling is a policy decision made by the caller (the viewer defaults
 * to warning, never aborting an otherwise inspectable file — checksum
 * validity says nothing about whether a file is safe to print).
 */

export type ChecksumStatus = "valid" | "missing" | "mismatched";

export interface ChecksumResult {
  status: ChecksumStatus;
  declared: number | null;
  computed: number | null;
}

export function computeGCodeChecksum(text: string): number {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum ^= text.charCodeAt(i);
  return sum;
}

export function verifyChecksum(rawLine: string): ChecksumResult {
  const starIndex = rawLine.indexOf("*");
  if (starIndex === -1) return { status: "missing", declared: null, computed: null };

  const body = rawLine.slice(0, starIndex);
  const suffix = rawLine.slice(starIndex + 1);
  const computed = computeGCodeChecksum(body);
  const declaredNum = Number(suffix);

  if (suffix.length === 0 || !Number.isFinite(declaredNum) || !/^\d+$/.test(suffix.trim())) {
    return { status: "mismatched", declared: null, computed };
  }

  const declared = Math.trunc(declaredNum);
  return { status: declared === computed ? "valid" : "mismatched", declared, computed };
}
