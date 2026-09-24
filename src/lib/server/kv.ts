/**
 * Upstash Redis client (Vercel's recommended replacement for the now
 * deprecated @vercel/kv). Holds exactly two record shapes:
 *
 * - `license-by-email:{lowercased email}` -> the most recent license key
 *   issued to that email, so "forgot my license key" can resend it.
 * - `payment-delivered:{payment_id}` -> "1" once the welcome/admin emails
 *   have been sent for that payment, so the webhook path and the
 *   checkout-return-page path (see src/pages/pro/welcome) can't both
 *   send a duplicate welcome email for the same purchase.
 * - `payment-email:{payment_id}` -> the buyer's email, written by the
 *   webhook's `payment.succeeded` handler and read back by its
 *   `license_key.created` handler (that event carries the key but only
 *   a `customer_id`, not an email — see src/pages/api/webhooks/dodo.ts).
 */
import { Redis } from "@upstash/redis";
import { getUpstashRedisToken, getUpstashRedisUrl } from "./env";

let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new Redis({ url: getUpstashRedisUrl(), token: getUpstashRedisToken() });
  }
  return client;
}

function emailKey(email: string): string {
  return `license-by-email:${email.trim().toLowerCase()}`;
}

function deliveredKey(paymentId: string): string {
  return `payment-delivered:${paymentId}`;
}

function paymentEmailKey(paymentId: string): string {
  return `payment-email:${paymentId}`;
}

export async function recordLicenseForEmail(email: string, licenseKey: string): Promise<void> {
  await getClient().set(emailKey(email), licenseKey);
}

export async function getLicenseForEmail(email: string): Promise<string | null> {
  const value = await getClient().get<string>(emailKey(email));
  return value ?? null;
}

/**
 * Atomically claims delivery for a payment. Returns true the first time
 * it's called for a given payment_id (caller should send the emails),
 * false on every subsequent call (already delivered, skip).
 */
export async function claimPaymentDelivery(paymentId: string): Promise<boolean> {
  const result = await getClient().set(deliveredKey(paymentId), "1", { nx: true, ex: 60 * 60 * 24 * 7 });
  return result === "OK";
}

export async function recordPaymentEmail(paymentId: string, email: string): Promise<void> {
  await getClient().set(paymentEmailKey(paymentId), email, { ex: 60 * 60 });
}

export async function getPaymentEmail(paymentId: string): Promise<string | null> {
  const value = await getClient().get<string>(paymentEmailKey(paymentId));
  return value ?? null;
}
