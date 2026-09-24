/**
 * Thin wrappers around Dodo Payments' public license-key endpoints
 * (activate/validate/deactivate). These are documented as public — they
 * take no API key — but are called from our own server routes rather
 * than directly from the browser so the client only ever talks to our
 * own /api/license/* routes and we have one place to adapt if Dodo's
 * response shape changes.
 */
import { getDodoApiBaseUrl } from "./env";

export interface DodoActivateResult {
  ok: boolean;
  instanceId?: string;
  error?: string;
}

export interface DodoValidateResult {
  ok: boolean;
  valid: boolean;
  error?: string;
}

async function postJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${getDodoApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function activateLicense(licenseKey: string, deviceName: string): Promise<DodoActivateResult> {
  const { status, json } = await postJson("/licenses/activate", { license_key: licenseKey, name: deviceName });
  if (status >= 200 && status < 300 && json?.id) {
    return { ok: true, instanceId: json.id };
  }
  return { ok: false, error: json?.message ?? `Activation failed (HTTP ${status})` };
}

export async function validateLicense(licenseKey: string): Promise<DodoValidateResult> {
  const { status, json } = await postJson("/licenses/validate", { license_key: licenseKey });
  if (status >= 200 && status < 300 && typeof json?.valid === "boolean") {
    return { ok: true, valid: json.valid };
  }
  return { ok: false, valid: false, error: json?.message ?? `Validation failed (HTTP ${status})` };
}

export async function deactivateLicense(licenseKey: string, instanceId: string): Promise<{ ok: boolean; error?: string }> {
  const { status, json } = await postJson("/licenses/deactivate", {
    license_key: licenseKey,
    license_key_instance_id: instanceId,
  });
  if (status >= 200 && status < 300) {
    return { ok: true };
  }
  return { ok: false, error: json?.message ?? `Deactivation failed (HTTP ${status})` };
}
