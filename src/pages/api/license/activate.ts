/**
 * Proxies Dodo Payments' public license-activate endpoint, so the
 * client only ever talks to our own /api/* routes. Called both from the
 * pricing page's "have a license key" form and automatically right
 * after a successful purchase (see src/pages/pro/welcome).
 */
import type { APIRoute } from "astro";
import { activateLicense } from "../../../lib/server/dodo-license";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: { licenseKey?: unknown; deviceName?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request body" }, 400);
  }

  if (typeof body.licenseKey !== "string" || body.licenseKey.trim().length === 0) {
    return json({ ok: false, error: "licenseKey is required" }, 400);
  }
  const deviceName = typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim() : "Browser";

  try {
    const result = await activateLicense(body.licenseKey.trim(), deviceName);
    if (!result.ok) {
      return json({ ok: false, error: result.error ?? "That license key couldn't be activated." }, 422);
    }
    return json({ ok: true, instanceId: result.instanceId }, 200);
  } catch (error) {
    console.error("license/activate failed", error);
    return json({ ok: false, error: "Something went wrong activating that key. Please try again." }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
