/**
 * Dodo Payments webhook — the PRIMARY, always-fired delivery path.
 * Signature verification is handled by @dodopayments/astro's Webhooks
 * handler (Standard Webhooks HMAC verification), not hand-rolled here.
 *
 * Field shapes below are taken directly from the installed SDK's own
 * types (node_modules/@dodopayments/core/dist/schemas/webhook.d.ts),
 * not guessed:
 *   - payment.succeeded / payment.failed: { data: { payment_id, customer:
 *     { email }, total_amount, currency, error_message, ... } }
 *   - license_key.created: { data: { key, payment_id, customer_id, ... } }
 *     — this event carries the actual issued key, but only a
 *     `customer_id`, never an email. We bridge the two events by
 *     stashing payment_id -> email in KV from the payment.succeeded
 *     handler (short-lived; license_key.created fires moments later)
 *     and reading it back here.
 *
 * The admin "full payload" notification (requirement: an email with the
 * whole info object, on both success and failure) is sent
 * unconditionally from payment.succeeded/payment.failed, regardless of
 * whether a license key has been issued yet.
 *
 * The user welcome email is sent from onLicenseKeyCreated once we can
 * resolve an email for its payment_id. If that lookup misses (e.g. the
 * two events arrive out of order, or in a different serverless
 * invocation before KV propagates), the checkout return-page fallback
 * (src/pages/api/license/deliver.ts, which reads the license_key Dodo
 * reliably appends to the return_url query string) completes delivery
 * instead. `claimPaymentDelivery` makes the two paths mutually
 * exclusive so a purchase never produces two welcome emails.
 */
import { Webhooks } from "@dodopayments/astro";
import { siteConfig } from "../../../config/site";
import { getDodoWebhookKey } from "../../../lib/server/env";
import { sendAdminPaymentEvent, sendWelcomeEmail } from "../../../lib/server/email";
import { claimPaymentDelivery, getPaymentEmail, recordLicenseForEmail, recordPaymentEmail } from "../../../lib/server/kv";

export const prerender = false;

export const POST = Webhooks({
  webhookKey: getDodoWebhookKey(),

  onPaymentSucceeded: async (payload) => {
    const { payment_id: paymentId, customer } = payload.data;
    await sendAdminPaymentEvent("succeeded", { email: customer.email, paymentId, rawPayload: payload });
    await recordPaymentEmail(paymentId, customer.email);
  },

  onPaymentFailed: async (payload) => {
    const { payment_id: paymentId, customer } = payload.data;
    await sendAdminPaymentEvent("failed", { email: customer?.email, paymentId, rawPayload: payload });
  },

  onLicenseKeyCreated: async (payload) => {
    const { key: licenseKey, payment_id: paymentId } = payload.data;
    if (!paymentId) return;

    const email = await getPaymentEmail(paymentId);
    if (!email) return;

    const claimed = await claimPaymentDelivery(paymentId);
    if (!claimed) return;

    await recordLicenseForEmail(email, licenseKey);
    await sendWelcomeEmail({
      to: email,
      licenseKey,
      goToAppUrl: siteConfig.siteUrl,
      activateUrl: `${siteConfig.siteUrl}/pricing/#activate`,
    });
  },
});
