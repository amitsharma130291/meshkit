/**
 * Proxies Dodo Payments' public license-validate endpoint. The browser
 * never calls Dodo directly (see production-isolation.test.ts) — this
 * is the one server hop in between, so we have a single place to adapt
 * if Dodo's response shape ever changes.
 */
import type { APIRoute } from "astro";
import { validateLicense } from "../../../lib/server/dodo-license";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: { licenseKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ valid: false, error: "Malformed request body" }, 400);
  }

  if (typeof body.licenseKey !== "string" || body.licenseKey.trim().length === 0) {
    return json({ valid: false, error: "licenseKey is required" }, 400);
  }

  try {
    const result = await validateLicense(body.licenseKey.trim());
    if (!result.ok) {
      return json({ valid: false, error: result.error }, 502);
    }
    return json({ valid: result.valid }, 200);
  } catch (error) {
    console.error("license/verify failed", error);
    // Fail closed: a broken verification path must never look like a
    // valid license to the entitlement provider (see production-provider.ts).
    return json({ valid: false, error: "Verification is temporarily unavailable." }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
