// Pure URL helpers shared by the audit script and its unit tests.

const PLACEHOLDER_HOSTS = new Set(["example.com", "www.example.com", "localhost", "127.0.0.1"]);

/** True for example.com/localhost/a bare IP — never a real launch domain. */
export function isPlaceholderOrigin(urlString) {
  try {
    const url = new URL(urlString);
    if (PLACEHOLDER_HOSTS.has(url.hostname)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return true;
    if (url.hostname.endsWith(".local")) return true;
    return false;
  } catch {
    return true;
  }
}

/** A canonical/OG/sitemap URL must be absolute, https, no fragment, no query. */
export function validateAbsoluteUrl(urlString) {
  const issues = [];
  let url;
  try {
    url = new URL(urlString);
  } catch {
    issues.push(`not a valid absolute URL: "${urlString}"`);
    return issues;
  }
  if (url.protocol !== "https:") issues.push(`not https: "${urlString}"`);
  if (url.hash) issues.push(`contains a fragment: "${urlString}"`);
  if (url.search) issues.push(`contains a query/tracking parameter: "${urlString}"`);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") issues.push(`points at localhost: "${urlString}"`);
  return issues;
}

/** MeshWrench's policy is a trailing slash on every route except the root and file-like endpoints. */
export function hasConsistentTrailingSlash(pathname) {
  if (pathname === "/") return true;
  if (/\.[a-z0-9]+$/i.test(pathname)) return true; // e.g. /robots.txt, /sitemap-index.xml
  return pathname.endsWith("/");
}

/** Strips origin + trailing slash so two "same route" URLs compare equal regardless of absolute form. */
export function normalizePathname(pathnameOrUrl) {
  let pathname;
  try {
    pathname = new URL(pathnameOrUrl).pathname;
  } catch {
    pathname = pathnameOrUrl;
  }
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname === "" ? "/" : pathname;
}
