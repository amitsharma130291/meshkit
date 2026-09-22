export type CapabilityKey =
  | "webAssembly"
  | "webWorkers"
  | "moduleWorkers"
  | "webglAny"
  | "webgl2"
  | "fileApi"
  | "blobUrls"
  | "transferableArrayBuffer"
  | "offscreenCanvas"
  | "sharedArrayBuffer";

export type RawCapabilityFlags = Record<CapabilityKey, boolean>;

export interface CapabilityReport {
  required: CapabilityKey[];
  missingRequired: CapabilityKey[];
  optional: CapabilityKey[];
  missingOptional: CapabilityKey[];
  /** True only when every required capability is present. */
  ready: boolean;
  recoveryMessages: string[];
}

/** Capabilities a tool cannot function at all without. */
const REQUIRED_CAPABILITIES: CapabilityKey[] = ["webAssembly", "webWorkers", "fileApi", "blobUrls", "webglAny"];

/**
 * Nice-to-haves that improve performance or offer a smoother experience
 * but must never block a tool from running. Notably `sharedArrayBuffer` is
 * detected but never required — enabling it would mean turning on
 * cross-origin isolation (COOP/COEP) site-wide for a hypothetical future
 * gain, which this phase explicitly avoids.
 */
const OPTIONAL_CAPABILITIES: CapabilityKey[] = [
  "moduleWorkers",
  "webgl2",
  "transferableArrayBuffer",
  "offscreenCanvas",
  "sharedArrayBuffer",
];

const RECOVERY_MESSAGES: Record<CapabilityKey, string> = {
  webAssembly: "Update your browser to a recent version of Chrome, Firefox, Safari or Edge.",
  webWorkers: "Update your browser to a recent version of Chrome, Firefox, Safari or Edge.",
  moduleWorkers: "Update your browser for faster local processing.",
  webglAny: "Enable hardware acceleration in your browser settings, or try a different browser.",
  webgl2: "Update your browser for a smoother 3D preview.",
  fileApi: "Update your browser to a recent version of Chrome, Firefox, Safari or Edge.",
  blobUrls: "Update your browser to a recent version of Chrome, Firefox, Safari or Edge.",
  transferableArrayBuffer: "Update your browser for faster file handling.",
  offscreenCanvas: "Update your browser for smoother rendering.",
  sharedArrayBuffer: "Not required — no action needed.",
};

/** Pure normalizer: turns raw feature flags into a categorized, user-actionable report. */
export function normalizeCapabilities(flags: RawCapabilityFlags): CapabilityReport {
  const missingRequired = REQUIRED_CAPABILITIES.filter((key) => !flags[key]);
  const missingOptional = OPTIONAL_CAPABILITIES.filter((key) => !flags[key]);

  return {
    required: REQUIRED_CAPABILITIES,
    missingRequired,
    optional: OPTIONAL_CAPABILITIES,
    missingOptional,
    ready: missingRequired.length === 0,
    recoveryMessages: missingRequired.map((key) => RECOVERY_MESSAGES[key]),
  };
}

/** Touches `window`/`navigator`/DOM APIs — call only in the browser, never at build/SSR time. */
export function detectBrowserCapabilities(): RawCapabilityFlags {
  const hasWebgl = (contextId: "webgl" | "webgl2"): boolean => {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext(contextId));
    } catch {
      return false;
    }
  };

  const webgl2 = hasWebgl("webgl2");

  return {
    webAssembly: typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function",
    webWorkers: typeof Worker !== "undefined",
    moduleWorkers: typeof Worker !== "undefined", // classic vs. module support is verified at construction time
    webglAny: webgl2 || hasWebgl("webgl"),
    webgl2,
    fileApi: typeof File !== "undefined" && typeof FileReader !== "undefined",
    blobUrls: typeof URL !== "undefined" && typeof URL.createObjectURL === "function",
    transferableArrayBuffer: typeof ArrayBuffer !== "undefined" && typeof structuredClone === "function",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  };
}

export function getCapabilityReport(): CapabilityReport {
  return normalizeCapabilities(detectBrowserCapabilities());
}
