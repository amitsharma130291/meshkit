import { describe, expect, it } from "vitest";
import { parseXML, type XMLAttributes } from "./xml";

function collect(xml: string): { events: string[]; attrs: XMLAttributes[] } {
  const events: string[] = [];
  const attrs: XMLAttributes[] = [];
  parseXML(xml, {
    onStartElement(name, a) {
      events.push(`start:${name}`);
      attrs.push(a);
    },
    onEndElement(name) {
      events.push(`end:${name}`);
    },
  });
  return { events, attrs };
}

describe("parseXML", () => {
  it("parses nested elements with attributes", () => {
    const { events, attrs } = collect(`<a id="1"><b x="2" y="3"/></a>`);
    expect(events).toEqual(["start:a", "start:b", "end:b", "end:a"]);
    expect(attrs[0]).toEqual({ id: "1" });
    expect(attrs[1]).toEqual({ x: "2", y: "3" });
  });

  it("strips namespace prefixes from element and attribute names", () => {
    const { events, attrs } = collect(`<m:model xmlns:m="urn:x"><m:resources m:count="0"/></m:model>`);
    expect(events).toEqual(["start:model", "start:resources", "end:resources", "end:model"]);
    // `xmlns:m` is just another prefixed attribute to this minimal parser — it strips to "m", same as any other.
    expect(attrs[0]).toEqual({ m: "urn:x" });
    expect(attrs[1]).toEqual({ count: "0" });
  });

  it("skips XML declarations, comments and CDATA without emitting events for them", () => {
    const { events } = collect(`<?xml version="1.0"?><!-- comment --><a><![CDATA[ignored]]></a>`);
    expect(events).toEqual(["start:a", "end:a"]);
  });

  it("accepts single or double quoted attribute values", () => {
    const { attrs } = collect(`<a x='1' y="2"/>`);
    expect(attrs[0]).toEqual({ x: "1", y: "2" });
  });

  it("decodes predefined XML entities and numeric character references", () => {
    const { attrs } = collect(`<a name="A &amp; B &lt;&gt; &quot;&apos; &#65;&#x42;"/>`);
    expect(attrs[0].name).toBe(`A & B <> "' AB`);
  });

  it("ignores text content between tags — only attributes carry data", () => {
    const { events } = collect(`<a>some text that is not a tag<b/>more text</a>`);
    expect(events).toEqual(["start:a", "start:b", "end:b", "end:a"]);
  });

  it("handles mixed whitespace and newlines inside tags", () => {
    const { attrs } = collect(`<a\n  x = "1"\n\ty="2" />`);
    expect(attrs[0]).toEqual({ x: "1", y: "2" });
  });

  it("rejects a DOCTYPE declaration", () => {
    expect(() => collect(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>`)).toThrow();
  });

  it("rejects malformed XML with mismatched closing tags", () => {
    expect(() => collect(`<a><b></a></b>`)).toThrow();
  });

  it("rejects XML with unclosed elements", () => {
    expect(() => collect(`<a><b></b>`)).toThrow();
  });

  it("rejects a malformed tag", () => {
    expect(() => collect(`<a <b/></a>`)).toThrow();
  });
});
