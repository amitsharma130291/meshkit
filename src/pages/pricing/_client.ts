import { getOrCreateDeviceName, setStoredLicense } from "../../lib/pro/license-storage";

function showFailedBannerIfPresent(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") !== "failed") return;
  const banner = document.querySelector<HTMLElement>("#payment-failed-banner");
  if (banner) banner.hidden = false;
}

function setPending(button: HTMLButtonElement, pending: boolean): void {
  const label = button.querySelector<HTMLElement>("[data-label]");
  const spinner = button.querySelector<HTMLElement>("[data-spinner]");
  button.disabled = pending;
  if (label) label.hidden = pending;
  if (spinner) spinner.hidden = !pending;
}

function initCheckoutForm(): void {
  const form = document.querySelector<HTMLFormElement>("#checkout-form");
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement>("[data-checkout-submit]")!;
  const errorEl = form.querySelector<HTMLElement>("[data-checkout-error]")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const email = (new FormData(form).get("email") as string)?.trim();
    if (!email) return;

    setPending(button, true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.checkoutUrl) {
        throw new Error(body.error ?? "Couldn't start checkout. Please try again.");
      }
      window.location.href = body.checkoutUrl;
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : "Couldn't start checkout. Please try again.";
      errorEl.hidden = false;
      setPending(button, false);
    }
  });
}

function initActivateForm(): void {
  const form = document.querySelector<HTMLFormElement>("#activate-form");
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement>("[data-activate-submit]")!;
  const errorEl = form.querySelector<HTMLElement>("[data-activate-error]")!;
  const successEl = form.querySelector<HTMLElement>("[data-activate-success]")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    successEl.hidden = true;
    const licenseKey = (new FormData(form).get("licenseKey") as string)?.trim();
    if (!licenseKey) return;

    setPending(button, true);
    try {
      const deviceName = getOrCreateDeviceName(window.localStorage);
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ licenseKey, deviceName }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? "That license key couldn't be activated.");
      }
      setStoredLicense(window.localStorage, { licenseKey, instanceId: body.instanceId });
      successEl.textContent = "Pro is now active on this device. Taking you to the app…";
      successEl.hidden = false;
      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : "That license key couldn't be activated.";
      errorEl.hidden = false;
      setPending(button, false);
    }
  });
}

function initForgotForm(): void {
  const form = document.querySelector<HTMLFormElement>("#forgot-form");
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement>("[data-forgot-submit]")!;
  const successEl = form.querySelector<HTMLElement>("[data-forgot-success]")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    successEl.hidden = true;
    const email = (new FormData(form).get("email") as string)?.trim();
    if (!email) return;

    setPending(button, true);
    try {
      const res = await fetch("/api/license/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      successEl.textContent = body.message ?? "If that email has a Pro license, we've sent it.";
      successEl.hidden = false;
    } catch {
      successEl.textContent = "If that email has a Pro license, we've sent it.";
      successEl.hidden = false;
    } finally {
      setPending(button, false);
    }
  });
}

showFailedBannerIfPresent();
initCheckoutForm();
initActivateForm();
initForgotForm();
