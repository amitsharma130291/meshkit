import type { APIRoute } from "astro";
import { siteConfig } from "../../config/site";
import { createCheckoutSession } from "../../lib/server/dodo-checkout";

export const prerender = false;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request }) => {
  let body: { email?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request body" }, 400);
  }

  if (typeof body.email !== "string" || !EMAIL_PATTERN.test(body.email.trim())) {
    return json({ ok: false, error: "A valid email address is required" }, 400);
  }

  try {
    const result = await createCheckoutSession({
      email: body.email.trim(),
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      returnUrl: `${siteConfig.siteUrl}/pro/welcome/`,
    });

    if (!result.ok) {
      return json({ ok: false, error: result.error }, 502);
    }
    return json({ ok: true, checkoutUrl: result.checkoutUrl }, 200);
  } catch (error) {
    console.error("checkout failed", error);
    return json({ ok: false, error: "Couldn't start checkout right now. Please try again shortly." }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
