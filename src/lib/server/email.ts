/**
 * All outbound transactional email goes through this one module — Gmail
 * SMTP via Nodemailer, per the project owner's own account. Kinds of
 * mail:
 *   1. Admin notification (the full raw Dodo webhook payload, on both
 *      success and failure) — see requirements 1 and "if payment fails".
 *   2. User welcome (license key + how to activate + go-to-app button).
 *   3. User "forgot license key" resend (same key, shorter framing).
 *   4. Contact-form submission (admin only, reply-to set to the
 *      submitter so a direct "Reply" in the inbox goes straight back to
 *      them — see src/pages/api/contact.ts).
 */
import nodemailer from "nodemailer";
import { siteConfig } from "../../config/site";
import { getAdminNotificationEmail, getGmailSmtpAppPassword, getGmailSmtpUser } from "./env";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: getGmailSmtpUser(), pass: getGmailSmtpAppPassword() },
    });
  }
  return transporter;
}

async function send(to: string, subject: string, html: string, text: string, replyTo?: string): Promise<void> {
  await getTransporter().sendMail({
    from: `${siteConfig.productName} <${getGmailSmtpUser()}>`,
    to,
    subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
}

export async function sendAdminPaymentEvent(
  kind: "succeeded" | "failed",
  info: { email?: string; licenseKey?: string; paymentId?: string; rawPayload: unknown },
): Promise<void> {
  const subject =
    kind === "succeeded"
      ? `[${siteConfig.productName}] Pro payment succeeded — ${info.email ?? "unknown email"}`
      : `[${siteConfig.productName}] Pro payment FAILED — ${info.email ?? "unknown email"}`;
  const pretty = JSON.stringify(info.rawPayload, null, 2);
  const html = `
    <h2>${kind === "succeeded" ? "Payment succeeded" : "Payment failed"}</h2>
    <p><strong>Email:</strong> ${escapeHtml(info.email ?? "(none)")}</p>
    <p><strong>License key:</strong> ${escapeHtml(info.licenseKey ?? "(none)")}</p>
    <p><strong>Payment ID:</strong> ${escapeHtml(info.paymentId ?? "(none)")}</p>
    <p><strong>Full webhook payload:</strong></p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:8px;white-space:pre-wrap;">${escapeHtml(pretty)}</pre>
  `;
  const text = `${kind === "succeeded" ? "Payment succeeded" : "Payment failed"}\nEmail: ${info.email ?? "(none)"}\nLicense key: ${info.licenseKey ?? "(none)"}\nPayment ID: ${info.paymentId ?? "(none)"}\n\nFull payload:\n${pretty}`;
  await send(getAdminNotificationEmail(), subject, html, text);
}

export async function sendWelcomeEmail(params: {
  to: string;
  licenseKey: string;
  goToAppUrl: string;
  activateUrl: string;
}): Promise<void> {
  const subject = `Welcome to ${siteConfig.productName} Pro — your license key inside`;
  const html = `
    <h1>You're all set — ${siteConfig.productName} Pro is active</h1>
    <p>Thanks for upgrading. Your setup is done and Pro is unlocked in your browser on this device.</p>
    <p style="margin:24px 0;">
      <a href="${params.goToAppUrl}" style="background:#4524D8;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Go to the app →</a>
    </p>
    <p><strong>Your license key:</strong></p>
    <p style="font-family:monospace;font-size:1.1rem;background:#f4f4f4;padding:10px 14px;border-radius:8px;display:inline-block;">${escapeHtml(params.licenseKey)}</p>
    <h2>If you ever need to re-activate</h2>
    <p>
      Pro is remembered on this device automatically. If you clear your browser storage,
      switch devices, or ever see a "Pro not active" message, just re-enter this license
      key on the activation page:
    </p>
    <p><a href="${params.activateUrl}">${params.activateUrl}</a></p>
    <p>You can also request this key again any time from the "Forgot your license key?" link on the pricing page — we'll email it to this address.</p>
    <p style="color:#888;font-size:.85rem;margin-top:32px;">${siteConfig.productName} — ${siteConfig.privacyPromise}</p>
  `;
  const text = `You're all set — ${siteConfig.productName} Pro is active.\n\nGo to the app: ${params.goToAppUrl}\n\nYour license key: ${params.licenseKey}\n\nIf you ever need to re-activate (cleared storage, new device), enter this key at: ${params.activateUrl}\n\nYou can also request this key again from the "Forgot your license key?" link on the pricing page.`;
  await send(params.to, subject, html, text);
}

export async function sendForgotKeyEmail(params: { to: string; licenseKey: string; activateUrl: string }): Promise<void> {
  const subject = `Your ${siteConfig.productName} Pro license key`;
  const html = `
    <h1>Here's your license key</h1>
    <p style="font-family:monospace;font-size:1.1rem;background:#f4f4f4;padding:10px 14px;border-radius:8px;display:inline-block;">${escapeHtml(params.licenseKey)}</p>
    <p>Enter it on the activation page to unlock Pro on this device:</p>
    <p><a href="${params.activateUrl}">${params.activateUrl}</a></p>
    <p style="color:#888;font-size:.85rem;margin-top:32px;">${siteConfig.productName} — ${siteConfig.privacyPromise}</p>
  `;
  const text = `Your license key: ${params.licenseKey}\n\nEnter it on the activation page to unlock Pro on this device: ${params.activateUrl}`;
  await send(params.to, subject, html, text);
}

export async function sendContactFormEmail(params: {
  name: string;
  email: string;
  subject: string;
  message: string;
}): Promise<void> {
  const domain = new URL(siteConfig.siteUrl).hostname;
  const subject = `[${siteConfig.productName} Contact] ${params.subject}`;
  const html = `
    <h2>New contact form submission</h2>
    <p><strong>From:</strong> ${escapeHtml(params.name)} &lt;${escapeHtml(params.email)}&gt;</p>
    <p><strong>Site:</strong> ${escapeHtml(domain)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(params.subject)}</p>
    <p><strong>Message:</strong></p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:8px;white-space:pre-wrap;font-family:inherit;">${escapeHtml(params.message)}</pre>
  `;
  const text = `New contact form submission\nFrom: ${params.name} <${params.email}>\nSite: ${domain}\nSubject: ${params.subject}\n\nMessage:\n${params.message}`;
  await send(getAdminNotificationEmail(), subject, html, text, params.email);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
