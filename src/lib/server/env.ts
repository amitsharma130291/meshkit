/**
 * Typed, fail-loud access to server-only environment variables used by
 * Phase 11's payment/license API routes. Every one of these must be set
 * in Vercel project settings (and a local `.env` for `astro dev`) — see
 * `.env.example`. Reading a missing var throws immediately at the call
 * site rather than letting `undefined` silently propagate into a Dodo
 * API call or an email send.
 */
function requireEnv(name: string): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} — see .env.example`);
  }
  return value;
}

export function getDodoApiKey(): string {
  return requireEnv("DODO_PAYMENTS_API_KEY");
}

export function getDodoWebhookKey(): string {
  return requireEnv("DODO_PAYMENTS_WEBHOOK_KEY");
}

export function getDodoEnvironment(): "test_mode" | "live_mode" {
  const value = requireEnv("DODO_PAYMENTS_ENVIRONMENT");
  if (value !== "test_mode" && value !== "live_mode") {
    throw new Error(`DODO_PAYMENTS_ENVIRONMENT must be "test_mode" or "live_mode", got "${value}"`);
  }
  return value;
}

export function getDodoProductId(): string {
  return requireEnv("DODO_PAYMENTS_PRODUCT_ID");
}

export function getDodoApiBaseUrl(): string {
  return getDodoEnvironment() === "test_mode" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
}

export function getUpstashRedisUrl(): string {
  return requireEnv("KV_REST_API_URL");
}

export function getUpstashRedisToken(): string {
  return requireEnv("KV_REST_API_TOKEN");
}

export function getGmailSmtpUser(): string {
  return requireEnv("GMAIL_SMTP_USER");
}

export function getGmailSmtpAppPassword(): string {
  return requireEnv("GMAIL_SMTP_APP_PASSWORD");
}

export function getAdminNotificationEmail(): string {
  return requireEnv("ADMIN_NOTIFICATION_EMAIL");
}
