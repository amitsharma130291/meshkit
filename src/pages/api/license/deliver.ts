/**
 * Fallback delivery path, called from src/pages/pro/welcome (the Dodo
 * checkout `return_url` target) using the payment_id/email/license_key
 * Dodo appends to that redirect. The webhook handler
 * (src/pages/api/webhooks/dodo.ts) is the PRIMARY delivery path and
 * fires independently of whether the browser ever completes the
 * redirect — this route exists so the user still gets their welcome
 * email even if the webhook is slow or (in local/test-mode setups)
 * never reaches this deployment. Both paths call
 * `claimPaymentDelivery(paymentId)`, an atomic KV "set if not already
 * set" — whichever fires first wins, the other is a no-op, so a
 * purchase can never produce two welcome emails.
 */
import type { APIRoute } from "astro";
import { siteConfig } from "../../../config/site";
import { sendAdminPaymentEvent, sendWelcomeEmail } from "../../../lib/server/email";
import { claimPaymentDelivery, recordLicenseForEmail } from "../../../lib/server/kv";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: { paymentId?: unknown; email?: unknown; licenseKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request body" }, 400);
  }

  if (typeof body.paymentId !== "string" || typeof body.email !== "string" || typeof body.licenseKey !== "string") {
    return json({ ok: false, error: "paymentId, email and licenseKey are all required" }, 400);
  }
  const { paymentId, email, licenseKey } = body as { paymentId: string; email: string; licenseKey: string };

  try {
    const claimed = await claimPaymentDelivery(paymentId);
    if (!claimed) {
      return json({ ok: true, alreadyDelivered: true }, 200);
    }

    await recordLicenseForEmail(email, licenseKey);
    const goToAppUrl = siteConfig.siteUrl;
    const activateUrl = `${siteConfig.siteUrl}/pricing/#activate`;
    await sendWelcomeEmail({ to: email, licenseKey, goToAppUrl, activateUrl });
    await sendAdminPaymentEvent("succeeded", {
      email,
      licenseKey,
      paymentId,
      rawPayload: { source: "checkout-return-redirect", paymentId, email, licenseKey },
    });

    return json({ ok: true, alreadyDelivered: false }, 200);
  } catch (error) {
    console.error("license/deliver failed", error);
    return json({ ok: false, error: "Couldn't finish delivery — the license is still activatable manually." }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
