/**
 * A minimal, namespace-tolerant, SAX-style XML tokenizer scoped to what
 * OPC relationship files and 3MF model documents actually need: elements
 * and attributes. It deliberately does NOT build a DOM, does NOT resolve
 * DTDs or general/external entities (any `<!DOCTYPE`/`<!ENTITY`/etc. is
 * rejected outright — see the classic XXE attack this closes off), and
 * ignores text/CDATA content entirely, since every piece of data this
 * project reads from OPC/3MF XML (vertex coordinates, triangle indices,
 * transforms, relationship targets, ...) lives in attributes, not text
 * nodes. Every repeating regex group here is a simple, non-overlapping
 * "list of attributes" pattern with no nested quantifiers — safe from
 * catastrophic backtracking regardless of input size.
 */

export interface XMLAttributes {
  [name: string]: string;
}

export interface XMLHandler {
  onStartElement(localName: string, attributes: XMLAttributes): void;
  onEndElement(localName: string): void;
  /**
   * Optional: called with each run of text between two tags (entity-decoded).
   * Every existing caller (model-parser.ts, relationships.ts) omits this —
   * their behavior is unchanged, since text runs were already skipped
   * entirely before this was added. Only a handler that opts in (e.g. the
   * 3MF viewer's `<metadata>` reader) receives text at all.
   */
  onText?(text: string): void;
}

const TAG_PATTERN =
  /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR_PATTERN = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY_PATTERN = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g;

export function parseXML(text: string, handler: XMLHandler): void {
  if (/<!DOCTYPE/i.test(text)) {
    throw new Error("XML document declares a DOCTYPE, which is not permitted");
  }

  const stack: string[] = [];
  const length = text.length;
  let pos = 0;

  while (pos < length) {
    const lt = text.indexOf("<", pos);
    if (lt === -1) break; // trailing text after the last element — nothing left to read

    if (lt > pos && handler.onText) {
      handler.onText(decodeEntities(text.slice(pos, lt)));
    }

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("Unterminated XML comment");
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw new Error("Unterminated CDATA section");
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw new Error("Unterminated processing instruction");
      pos = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // Any other markup declaration (ENTITY/ELEMENT/ATTLIST/NOTATION, or a
      // DOCTYPE that slipped past the case-insensitive check above somehow).
      throw new Error("Unsupported XML markup declaration");
    }

    TAG_PATTERN.lastIndex = lt;
    const match = TAG_PATTERN.exec(text);
    if (!match || match.index !== lt) {
      throw new Error("Malformed XML tag");
    }
    const [, closingSlash, rawName, attrBlob, selfClosingSlash] = match;
    pos = TAG_PATTERN.lastIndex;

    const localName = stripPrefix(rawName);

    if (closingSlash) {
      if (stack.pop() !== localName) {
        throw new Error("Mismatched XML closing tag");
      }
      handler.onEndElement(localName);
      continue;
    }

    handler.onStartElement(localName, parseAttributes(attrBlob));

    if (selfClosingSlash) {
      handler.onEndElement(localName);
    } else {
      stack.push(localName);
    }
  }

  if (stack.length > 0) {
    throw new Error("XML document has unclosed elements");
  }
}

function parseAttributes(blob: string): XMLAttributes {
  const attributes: XMLAttributes = {};
  if (blob.length === 0) return attributes;
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(blob))) {
    const value = match[2] ?? match[3] ?? "";
    attributes[stripPrefix(match[1])] = decodeEntities(value);
  }
  return attributes;
}

function stripPrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_PATTERN, (whole, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        break;
    }
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
    }
    // Unknown named entity — resolving it would require a DTD, which is
    // never loaded here. Leave the original text untouched rather than guess.
    return whole;
  });
}
