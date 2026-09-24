// Scans rendered page text for claims MeshWrench's own product facts don't
// support — unsupported superlatives, guaranteed-repair language, and AI
// claims (there is no AI in this product). Pure text matching,
// deliberately conservative (case-insensitive phrase match) so it stays
// cheap to reason about and to unit test.
//
// This scanner previously also flagged any mention of "G-code Viewer" as
// a stale claim, from Phase 7's own homepage-staleness finding (a
// fabricated "G-code Viewer" card referenced a tool that didn't exist).
// Phase 9 built a real G-code Viewer (`gcode-viewer` in `toolRegistry`),
// so that specific rule is retired — the underlying regression it
// guarded against no longer applies now that the tool is real.
const BANNED_PHRASES = [
  {
    // Deliberately excludes the honest, negated form ("cannot guarantee
    // printability") that MeshWrench's own limitations sections use — only
    // an affirmative guarantee claim is a problem.
    phrase: /(?<!\b(?:cannot|can't|never|won't|does not|doesn't|no)\s{1,20})\bguarantee(d|s)?\s+(repair|printability|watertight)/i,
    reason: "guaranteed-repair/printability claim",
  },
  { phrase: /\b100%\s+repair(ed)?\b/i, reason: "\"100% repair\" claim" },
  { phrase: /\bperfect(ly)?\s+repair/i, reason: "\"perfect repair\" claim" },
  { phrase: /\bbest\s+(stl|3d|repair|converter|viewer)\b/i, reason: "unsupported \"best\" superlative" },
  { phrase: /\bAI[\s-]?(powered|driven|based)\b/i, reason: "AI claim — this product has no AI/ML component" },
  { phrase: /\bmachine\s+learning\b/i, reason: "machine-learning claim — this product has no ML component" },
  { phrase: /\buploaded?\s+to\s+our\s+server/i, reason: "server-upload claim — contradicts the local-only privacy promise" },
];

/** Returns [{ reason, match }] for every banned phrase found in `text`. */
export function scanForStaleClaims(text) {
  const findings = [];
  for (const { phrase, reason } of BANNED_PHRASES) {
    const match = text.match(phrase);
    if (match) findings.push({ reason, match: match[0] });
  }
  return findings;
}
