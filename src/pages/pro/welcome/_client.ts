import { getOrCreateDeviceName, setStoredLicense } from "../../../lib/pro/license-storage";

function showState(id: "welcome-loading" | "welcome-success" | "welcome-error"): void {
  for (const stateId of ["welcome-loading", "welcome-success", "welcome-error"] as const) {
    const el = document.querySelector<HTMLElement>(`#${stateId}`);
    if (el) el.hidden = stateId !== id;
  }
}

async function run(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const paymentId = params.get("payment_id");
  const email = params.get("email");
  const licenseKey = params.get("license_key");

  if (status !== "succeeded") {
    window.location.href = "/pricing/?payment=failed";
    return;
  }

  if (!paymentId || !email || !licenseKey) {
    showState("welcome-error");
    const message = document.querySelector<HTMLElement>("#welcome-error-message");
    if (message) message.textContent = "Your payment succeeded, but we couldn't read the confirmation details from the redirect.";
    return;
  }

  try {
    // Best-effort — the webhook is the authoritative delivery path and
    // may already have sent these emails; this just covers the case
    // where it hasn't (yet, or at all in a local test-mode setup).
    await fetch("/api/license/deliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId, email, licenseKey }),
    }).catch(() => {});

    const deviceName = getOrCreateDeviceName(window.localStorage);
    const activateRes = await fetch("/api/license/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey, deviceName }),
    });
    const activateBody = await activateRes.json();
    if (!activateRes.ok || !activateBody.ok) {
      throw new Error(activateBody.error ?? "Activation failed");
    }
    setStoredLicense(window.localStorage, { licenseKey, instanceId: activateBody.instanceId });

    const keyEl = document.querySelector<HTMLElement>("#welcome-key");
    if (keyEl) keyEl.textContent = licenseKey;
    showState("welcome-success");
  } catch {
    showState("welcome-error");
    const message = document.querySelector<HTMLElement>("#welcome-error-message");
    if (message) {
      message.textContent = "Your payment succeeded, but we couldn't automatically activate this device.";
    }
  }
}

void run();
