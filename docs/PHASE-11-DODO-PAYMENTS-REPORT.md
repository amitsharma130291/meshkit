# Phase 11: Dodo Payments checkout + license-key email flow

**Date:** 2026-09-24
**Scope:** Real Pro checkout (Dodo Payments, test mode), server-verified
license activation, and the five email/redirect behaviors requested —
built on top of a previously 100%-static site now deployed to Vercel.

---

## 1. What changed architecturally

This site was fully static (`output: "static"`, no adapter, no server
code at all) before this phase. A real payment flow needs a server, so:

- Added `@astrojs/vercel` as the build adapter (`astro.config.mjs`).
  Every existing page **stays statically prerendered** — nothing about
  the free tools changed. Only the new routes below opt into on-demand
  (serverless) rendering via `export const prerender = false`.
- `astro build` now emits `dist/client/` (static output) +
  `dist/server/` (the function bundle) instead of a flat `dist/`. Fixed
  the two scripts that hardcoded the old path
  (`scripts/audit-seo.mjs`, `scripts/generate-response-headers.mjs` —
  renamed from `generate-csp-headers.mjs`, see §10) via a new shared
  `scripts/dist-dir.mjs` helper.
- New server-only code lives under `src/lib/server/` — env var access,
  the Upstash Redis client, Nodemailer, and the Dodo API wrappers.
  `production-isolation.test.ts` now asserts nothing under
  `src/lib/server/` can ever be imported by browser-executed code
  (`_client.ts` files or `.astro` `<script>` blocks) — a real guarantee
  that Dodo/Gmail/Redis secrets can't leak into the client bundle.

## 2. Dodo Payments integration

Uses the official `@dodopayments/astro` SDK adapter, not a hand-rolled
integration:

- **Checkout** (`src/pages/api/checkout.ts` + `src/lib/server/dodo-checkout.ts`):
  the client only ever sends an email; the product id, price and
  `return_url` are always constructed server-side from
  `DODO_PAYMENTS_PRODUCT_ID` — a request to this route can't be used to
  check out a different or free product.
- **License activation/validation** (`src/pages/api/license/{activate,verify}.ts`
  + `src/lib/server/dodo-license.ts`): thin proxies to Dodo's own
  public `/licenses/activate` and `/licenses/validate` endpoints. Dodo
  itself issues and owns the license key (via a **License Key
  entitlement** attached to the Pro product) — this project never
  generates or validates keys itself.
- **Webhook** (`src/pages/api/webhooks/dodo.ts`): uses
  `@dodopayments/astro`'s `Webhooks()` handler, which verifies the
  Standard Webhooks HMAC signature (`webhook-id`/`webhook-signature`/
  `webhook-timestamp` headers) before any handler code runs — signature
  verification is never hand-rolled. Field names used
  (`data.customer.email`, `data.payment_id`, `data.key`, etc.) come
  directly from the installed SDK's own TypeScript types
  (`node_modules/@dodopayments/core/dist/schemas/webhook.d.ts`), not
  guessed from prose docs.

## 3. The five requested behaviors

1. **Admin gets the full info object on payment success** —
   `onPaymentSucceeded` in the webhook unconditionally emails
   `ADMIN_NOTIFICATION_EMAIL` the raw webhook payload as pretty-printed
   JSON, regardless of what else succeeds or fails afterward.
2. **User welcome email with license key, "done" message, Go-to-App
   button, and re-activation instructions** — `sendWelcomeEmail()`
   (`src/lib/server/email.ts`). Sent once a license key can be resolved
   for the purchase — see the two-path delivery design below.
3. **User redirected to the paid app after payment** —
   `src/pages/pro/welcome/` is the Dodo `return_url` target: it reads
   the `payment_id`/`email`/`license_key`/`status` Dodo appends to the
   redirect, delivers the welcome email if not already sent, activates
   the license in `localStorage`, and shows a "Go to the app →" button
   (auto-visible on success; the button itself is a manual click, not a
   silent auto-redirect, so the user always sees their license key
   on-screen at least once).
4. **Re-activating a key redirects to the app** — the pricing page's
   "have a license key" form (`src/pages/pricing/_client.ts`) stores the
   key locally on a successful `/api/license/activate` call and
   redirects to `/` after a short confirmation.
5. **"Forgot key" shows a loader, then a confirmation message** —
   `src/pages/pricing/_client.ts`'s `initForgotForm()` disables the
   button and shows a spinner while the request is in flight, then
   always shows the same generic confirmation text (see §5).

### Payment failure

- **Admin gets the full info object on failure** — `onPaymentFailed`
  unconditionally emails the raw payload, same as success.
- **User redirected to the pricing page with a failure banner above the
  fold** — `src/pages/pro/welcome/_client.ts` redirects to
  `/pricing/?payment=failed` whenever `status !== "succeeded"`; the
  pricing page shows `#payment-failed-banner` (styled, above the
  fold) when that query param is present. No charge is made by Dodo on
  a failed payment — nothing on this site's side ever charges anyone.

## 4. Two independent delivery paths, one guaranteed email

Dodo's `payment.succeeded` webhook event doesn't reliably carry the
issued license key in its payload (only `license_key.created` does, and
that event only has a `customer_id`, not an email). Rather than guess at
undocumented payload shapes, this uses two independent, mutually
exclusive delivery paths:

- **Webhook path** (primary, fires regardless of whether the browser
  ever returns from checkout): `onPaymentSucceeded` stashes
  `payment_id → email` in Redis; when `onLicenseKeyCreated` fires
  moments later with the actual key, it looks up that email and
  delivers.
- **Checkout-return path** (fallback): `/pro/welcome/` reliably has
  `email`/`license_key`/`payment_id` from the `return_url` query string
  Dodo documents, and calls `/api/license/deliver` with them directly.

Both call `claimPaymentDelivery(paymentId)`, an atomic Redis
"set-if-not-already-set" — whichever path resolves first sends the
welcome email; the other is a no-op. A purchase can never produce two
welcome emails, and it's very unlikely to produce zero.

## 5. Privacy: no email enumeration

`/api/license/forgot` always returns the same
`{ ok: true, message: "If that email has a Pro license, we've sent it." }`
regardless of whether the email was found — an attacker (or a curious
user) can't use this endpoint to discover which addresses have
purchased Pro.

## 6. Entitlement resolution (fail-closed, server-verified)

`src/lib/pro/production-provider.ts` was rewritten (previously always
resolved `"free"` — Phase 10 hadn't built this yet). New behavior:

1. Reads a stored `{ licenseKey, instanceId }` from `localStorage`
   (`src/lib/pro/license-storage.ts`). No stored key → resolves
   `"free"` immediately, no network call.
2. A stored key → **always** awaits `POST /api/license/verify` before
   ever resolving `"pro"`. Network failure, non-OK response, or
   `valid: false` all resolve non-`"pro"` — never optimistic, never
   trusts the stored key by itself.
3. `production-provider.test.ts` has a source-level guarantee test that
   the literal `"pro"` status string never appears in the file before
   the `/api/license/verify` fetch call — i.e. no code path can
   synchronously grant Pro.

## 7. Verified

- `npm run check` — 0 errors, 0 warnings, 0 hints (557 files).
- `npx vitest run` — 163 files, 2100 tests passing, including the
  rewritten `production-provider.test.ts` (9 tests: free-without-network,
  pro-on-valid, non-pro-on-invalid, fail-closed-on-network-error,
  fail-closed-on-5xx, source-level "pro" guarantee) and
  `production-isolation.test.ts` (11 tests, including the new
  secret-leakage guards).
- `npm run build` + `npm run seo:audit` — 30 routes audited (28 previous
  + `/pricing/` + `/pro/welcome/`), 0 critical, 0 warnings.
  `/pricing/` is `indexable-primary` and in the sitemap; `/pro/welcome/`
  is `noindex-utility`, excluded from the sitemap
  (`astro.config.mjs`'s sitemap `filter`), `noindex, nofollow` in its
  robots meta.
- **Manually tested in-browser (dev server, no real credentials
  configured yet)**: all three pricing-page forms submit correctly and
  fail gracefully with clean JSON error messages (not a leaked stack
  trace/dev-error page — found and fixed a real gap where a missing env
  var threw uncaught out of the route handlers). Found and fixed a real
  CSS bug during this testing: `.payment-banner`/`.welcome-state` both
  set an explicit `display: grid`, which — at equal CSS specificity —
  silently defeated the `hidden` HTML attribute, showing the payment-
  failed banner unconditionally and hiding all pricing-page content
  behind `opacity: 0` (a leftover `data-reveal` attribute copied from
  the homepage without also copying the homepage's own reveal-triggering
  `IntersectionObserver` script). Both fixed; verified visually after.
- **Not yet tested**: an actual Dodo test-mode purchase end-to-end
  (checkout → webhook → email → activation), since that requires the
  real credentials in §8. Everything up to the Dodo API boundary is
  built, wired, and verified; the boundary itself needs your test-mode
  values to exercise for real.

## 8. What you still need to do

None of this can be created on your behalf (accounts / dashboard
config are yours to set up) — but here's exactly what to create and
where to paste it (`.env.example` documents all of these too):

### Dodo Payments (test mode)
1. Dashboard → **Products** → create the $39 Pro product.
2. Dashboard → **Entitlements** → New → **License Key** integration
   type. Set an activation limit (e.g. `3` devices) and save.
3. Open the Pro product → **Advanced Settings → Entitlements & Credits**
   → attach the License Key entitlement you just created.
4. Dashboard → **Developer → API Keys** (test mode) → copy the key →
   `DODO_PAYMENTS_API_KEY`.
5. Copy the product's id (`pdt_...`) → `DODO_PAYMENTS_PRODUCT_ID`.
6. Dashboard → **Developer → Webhooks** → add an endpoint pointing at
   `https://<your-vercel-domain>/api/webhooks/dodo`, subscribed to at
   least: `payment.succeeded`, `payment.failed`, `license_key.created`.
   Copy its signing secret → `DODO_PAYMENTS_WEBHOOK_KEY`.
7. `DODO_PAYMENTS_ENVIRONMENT=test_mode`.

### Storage (Upstash Redis via Vercel)
8. Vercel project → **Storage** → add a Redis (Upstash) integration →
   copy the REST URL/token it gives you → `KV_REST_API_URL` /
   `KV_REST_API_TOKEN`.

### Email (Gmail SMTP, as you specified)
9. Google Account → **Security → 2-Step Verification → App passwords**
   → generate one for "Mail" → `GMAIL_SMTP_APP_PASSWORD`.
   `GMAIL_SMTP_USER=amitsharma00261@gmail.com`,
   `ADMIN_NOTIFICATION_EMAIL=amitsharma00261@gmail.com`.

### Wiring it up
10. Set all of the above in **Vercel → Project → Settings →
    Environment Variables** (and copy the same values into a local
    `.env` if you want to test with `astro dev` — see `.env.example`).
11. Deploy. Do a real test-mode purchase on `/pricing/` and confirm:
    the admin inbox gets the full-payload email, the buyer's inbox gets
    the welcome email with a working license key, `/pro/welcome/`
    activates automatically, and "Forgot your license key?" resends it.

## 10. Vercel deployment readiness (added after the above)

Two real gaps were found and fixed once the site was specifically
prepared for a Vercel deployment — both were invisible on `astro dev`
and would only have surfaced as silent regressions once actually live
on Vercel:

- **Security headers and the `/online-stl-viewer/` → `/stl-viewer/`
  redirect were Netlify/Cloudflare-Pages-only.** `public/_headers` and
  `public/_redirects` are conventions those platforms read; Vercel
  reads neither. Fixed:
  - The redirect now uses Astro's own adapter-agnostic `redirects`
    config (`astro.config.mjs`) instead of `public/_redirects` (now
    deleted). The Vercel adapter compiles it into a real 301 in
    `.vercel/output/config.json`, generated by Vercel's own official
    `@vercel/routing-utils` package — confirmed correct for both
    `/online-stl-viewer` and `/online-stl-viewer/` (Vercel's routing
    layer normalizes the trailing slash before matching).
  - `scripts/generate-csp-headers.mjs` was renamed to
    `generate-response-headers.mjs` and now writes the computed
    security headers (including the per-build JSON-LD CSP hashes) to
    **both** `dist/client/_headers` (Netlify/Cloudflare, kept for
    portability) **and** `.vercel/output/config.json`'s `routes` array
    (Vercel's Build Output API). A plain `vercel.json` at the repo root
    was deliberately *not* used for this — Vercel reads that file
    **before** the build runs, so it can't contain build-time-computed
    hashes; `.vercel/output/config.json` is the build's own output,
    read *after*.
- **The header/redirect script was wired as an npm `postbuild` hook,
  which only fires if the host's build command is literally `npm run
  build`.** Made it unconditional instead: `package.json`'s `"build"`
  script now directly chains `astro build && node
  scripts/generate-response-headers.mjs`, so it runs no matter how the
  build is invoked.

Also added `package.json`'s `engines.node` (mirroring Astro 5's own
supported range, `18.20.8 || ^20.3.0 || >=22.0.0`) so Vercel selects a
compatible Node runtime rather than guessing.

Verified: `npm run check` (0 errors), `npx vitest run` (163 files, 2100
tests), and `npm run build && npm run seo:audit` (30 routes, 0
critical, 0 warnings) all pass against the new adapter output.
Confirmed by direct inspection of the generated
`.vercel/output/config.json` that: the redirect route, the global
security-header route, the `/wasm/*` cache-control route, and the
hashed CSP are all present and correctly formed per Vercel's
documented Build Output API v3 schema.

## 11. Confirmation

Nothing was committed, pushed, deployed, or charged during this phase.
No real Dodo product/account was created by me (I can't create
third-party accounts) — you'll create the product/entitlement per §8.
No live payment was made or attempted. No Vercel project was created or
deployed by me — connecting the repo to a Vercel project and triggering
the first deployment is still yours to do.
