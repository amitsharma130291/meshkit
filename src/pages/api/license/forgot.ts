/**
 * "Forgot your license key?" — looks up the most recent key issued to
 * an email (recorded in KV at delivery time, see
 * src/lib/server/kv.ts and /api/license/deliver.ts + the webhook
 * handler) and re-sends it. Always returns a generic success message
 * regardless of whether the email was found, so this endpoint can't be
 * used to enumerate which addresses have purchased Pro.
 */
import type { APIRoute } from "astro";
import { siteConfig } from "../../../config/site";
import { sendForgotKeyEmail } from "../../../lib/server/email";
import { getLicenseForEmail } from "../../../lib/server/kv";

export const prerender = false;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request }) => {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request body" }, 400);
  }

  if (typeof body.email !== "string" || !EMAIL_PATTERN.test(body.email.trim())) {
    return json({ ok: false, error: "A valid email address is required" }, 400);
  }
  const email = body.email.trim();

  try {
    const licenseKey = await getLicenseForEmail(email);
    if (licenseKey) {
      const activateUrl = `${siteConfig.siteUrl}/pricing/#activate`;
      await sendForgotKeyEmail({ to: email, licenseKey, activateUrl });
    }
  } catch (error) {
    // Even a lookup/send failure never leaks whether the email exists —
    // log server-side, still return the same generic response.
    console.error("license/forgot failed", error);
  }

  return json({ ok: true, message: "If that email has a Pro license, we've sent it." }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
