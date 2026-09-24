/**
 * Persistence for an activated license key, over an injected `Storage`
 * (a real caller passes `window.localStorage`; tests pass an in-memory
 * fake) — the same dependency-injection pattern `src/lib/batch/presets.ts`
 * already uses, so this stays testable without DOM mocking and so a
 * missing/unavailable storage backend is the caller's problem to handle,
 * not something this module silently swallows.
 *
 * Storing a key here is never itself sufficient to grant Pro — see
 * `production-provider.ts`, which always re-verifies the stored key
 * against the server (`/api/license/verify`) before resolving `"pro"`.
 * This module only remembers what to verify; it never decides the
 * entitlement result itself.
 */
const LICENSE_KEY_STORAGE_KEY = "meshwrench.pro.license-key.v1";
const INSTANCE_ID_STORAGE_KEY = "meshwrench.pro.license-instance-id.v1";
const DEVICE_NAME_STORAGE_KEY = "meshwrench.pro.device-name.v1";

export interface StoredLicense {
  licenseKey: string;
  instanceId: string;
}

export function getStoredLicense(storage: Storage): StoredLicense | null {
  try {
    const licenseKey = storage.getItem(LICENSE_KEY_STORAGE_KEY);
    const instanceId = storage.getItem(INSTANCE_ID_STORAGE_KEY);
    if (!licenseKey || !instanceId) return null;
    return { licenseKey, instanceId };
  } catch {
    return null;
  }
}

export function setStoredLicense(storage: Storage, license: StoredLicense): void {
  try {
    storage.setItem(LICENSE_KEY_STORAGE_KEY, license.licenseKey);
    storage.setItem(INSTANCE_ID_STORAGE_KEY, license.instanceId);
  } catch {
    // Storage unavailable (private browsing, quota) — activation simply
    // won't persist across reloads; the caller's UI still reflects the
    // one-time verify result for this page view.
  }
}

export function clearStoredLicense(storage: Storage): void {
  try {
    storage.removeItem(LICENSE_KEY_STORAGE_KEY);
    storage.removeItem(INSTANCE_ID_STORAGE_KEY);
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}

/** A stable per-browser label sent to Dodo as the activation's device name — not a fingerprint, just a human-readable hint shown in the Dodo dashboard. */
export function getOrCreateDeviceName(storage: Storage): string {
  try {
    const existing = storage.getItem(DEVICE_NAME_STORAGE_KEY);
    if (existing) return existing;
    const generated = `Browser-${Math.random().toString(36).slice(2, 8)}`;
    storage.setItem(DEVICE_NAME_STORAGE_KEY, generated);
    return generated;
  } catch {
    return "Browser";
  }
}
