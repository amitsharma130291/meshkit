/**
 * Creates a Dodo Payments hosted checkout session for the single Pro
 * product. The product/price is always read from
 * `DODO_PAYMENTS_PRODUCT_ID` server-side — the client only ever
 * supplies a buyer email/name, never a product id or amount, so a
 * request to /api/checkout can't be used to check out a different
 * (or free) product.
 */
import { getDodoApiBaseUrl, getDodoApiKey, getDodoProductId } from "./env";

export interface CreateCheckoutResult {
  ok: boolean;
  checkoutUrl?: string;
  error?: string;
}

export async function createCheckoutSession(params: {
  email: string;
  name?: string;
  returnUrl: string;
}): Promise<CreateCheckoutResult> {
  const res = await fetch(`${getDodoApiBaseUrl()}/checkouts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getDodoApiKey()}`,
    },
    body: JSON.stringify({
      product_cart: [{ product_id: getDodoProductId(), quantity: 1 }],
      customer: { email: params.email, name: params.name },
      return_url: params.returnUrl,
      metadata: { source: "pricing-page" },
    }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok || !body?.checkout_url) {
    return { ok: false, error: body?.message ?? `Checkout session creation failed (HTTP ${res.status})` };
  }
  return { ok: true, checkoutUrl: body.checkout_url };
}
