import type { APIRoute } from "astro";
import { sendContactFormEmail } from "../../lib/server/email";

export const prerender = false;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;

export const POST: APIRoute = async ({ request }) => {
  let body: { name?: unknown; email?: unknown; subject?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!name || name.length > MAX_FIELD_LENGTH) {
    return json({ ok: false, error: "Please enter your name." }, 400);
  }
  if (!EMAIL_PATTERN.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (!subject || subject.length > MAX_FIELD_LENGTH) {
    return json({ ok: false, error: "Please enter a subject." }, 400);
  }
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return json({ ok: false, error: "Please enter a message." }, 400);
  }

  try {
    await sendContactFormEmail({ name, email, subject, message });
    return json({ ok: true }, 200);
  } catch (error) {
    console.error("contact form submission failed", error);
    return json({ ok: false, error: "Something went wrong sending your message. Please try again shortly." }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
