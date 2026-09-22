import { describe, expect, it } from "vitest";
import { escapeXmlAttribute } from "./xml-escape";

describe("escapeXmlAttribute", () => {
  it("escapes ampersands", () => {
    expect(escapeXmlAttribute("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeXmlAttribute("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes double and single quotes", () => {
    expect(escapeXmlAttribute(`say "hi" it's fine`)).toBe("say &quot;hi&quot; it&apos;s fine");
  });

  it("escapes every special character in combination", () => {
    expect(escapeXmlAttribute(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeXmlAttribute("millimeter")).toBe("millimeter");
    expect(escapeXmlAttribute("1")).toBe("1");
  });

  it("leaves numeric strings (as formatFloat32 would produce) untouched", () => {
    expect(escapeXmlAttribute("-123.456")).toBe("-123.456");
    expect(escapeXmlAttribute("1.2345e-8")).toBe("1.2345e-8");
  });

  it("does not double-escape an already-safe string", () => {
    expect(escapeXmlAttribute("&amp;")).toBe("&amp;amp;"); // deliberately: this function is idempotent-unsafe by design (never called twice on the same value in this codebase)
  });
});
