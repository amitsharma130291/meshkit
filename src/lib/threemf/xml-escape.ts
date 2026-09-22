/**
 * XML attribute-value escaping. Every element/attribute NAME the 3MF
 * writer emits is a fixed, hard-coded string (never user-controlled), so
 * this is only ever needed for attribute VALUES — and today, the only
 * values written are numbers from `formatFloat32()` (which can never
 * contain an XML-special character) and small fixed constants (a
 * document-scoped object id, `"millimeter"`). This helper exists anyway,
 * and is tested on its own, specifically so any future addition of
 * genuinely user-derived text (a future phase's object name, say) has a
 * safe, already-proven escaping path to reach for — the model writer
 * never had to invent one under pressure.
 */
const XML_ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ATTRIBUTE_ESCAPES[ch]);
}
