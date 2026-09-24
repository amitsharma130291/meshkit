// Thin, testable wrappers around linkedom for pulling exactly the fields
// the SEO audit cares about out of one built HTML file. Kept separate
// from the checks themselves so the parsing shape can be unit-tested
// against small inline HTML fixtures without needing a real build.
import { parseHTML } from "linkedom";

export function parsePage(html) {
  const { document } = parseHTML(html);

  const title = document.querySelector("title")?.textContent ?? null;
  const description = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  const robotsMeta = document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;
  const lang = document.documentElement.getAttribute("lang");
  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;

  const h1s = [...document.querySelectorAll("h1")].map((el) => el.textContent.trim());
  const mains = document.querySelectorAll("main");
  const navs = document.querySelectorAll("nav");
  const footers = document.querySelectorAll("footer");

  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((el) => ({
    level: Number(el.tagName[1]),
    text: el.textContent.trim(),
  }));

  const og = {};
  document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
    const prop = el.getAttribute("property");
    og[prop] = el.getAttribute("content");
  });
  const twitter = {};
  document.querySelectorAll('meta[name^="twitter:"]').forEach((el) => {
    const name = el.getAttribute("name");
    twitter[name] = el.getAttribute("content");
  });

  const jsonLdBlocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((el) => {
    try {
      return { raw: el.textContent, parsed: JSON.parse(el.textContent), error: null };
    } catch (err) {
      return { raw: el.textContent, parsed: null, error: String(err) };
    }
  });

  const links = [...document.querySelectorAll("a[href]")].map((el) => ({
    href: el.getAttribute("href"),
    text: el.textContent.trim(),
    insideNav: el.closest("nav") !== null,
  }));

  const images = [...document.querySelectorAll("img")].map((el) => ({
    src: el.getAttribute("src"),
    alt: el.getAttribute("alt"),
    width: el.getAttribute("width"),
    height: el.getAttribute("height"),
    loading: el.getAttribute("loading"),
  }));

  const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((el) => ({
    id: el.getAttribute("id"),
    ariaLabel: el.getAttribute("aria-label"),
    hasAssociatedLabel: el.id ? document.querySelector(`label[for="${el.id}"]`) !== null : false,
  }));

  // FAQ visible-content: every <details><summary> pair under a heading
  // section, used to cross-check against FAQPage JSON-LD questions.
  const visibleFaqQuestions = [...document.querySelectorAll("details > summary")].map((el) =>
    el.textContent.replace(/\s+/g, " ").trim(),
  );

  const noscriptText = [...document.querySelectorAll("noscript")].map((el) => el.textContent);

  return {
    title,
    description,
    canonical,
    robotsMeta,
    lang,
    viewport,
    h1s,
    mainCount: mains.length,
    navCount: navs.length,
    footerCount: footers.length,
    headings,
    og,
    twitter,
    jsonLdBlocks,
    links,
    images,
    fileInputs,
    visibleFaqQuestions,
    noscriptText,
    bodyText: document.body?.textContent ?? "",
  };
}
