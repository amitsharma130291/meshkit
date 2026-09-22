import { createSafeError, type SafeError } from "../errors";
import type { ThreeDFileExtension } from "./format-types";

export interface FileValidationConfig {
  allowedExtensions: ThreeDFileExtension[];
  maxSizeBytes: number;
}

export type FileValidationResult =
  | { valid: true; extension: ThreeDFileExtension }
  | { valid: false; error: SafeError };

/** Lowercases and strips the leading dot. Returns "" when there is no extension. */
export function normalizeExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot === -1 || lastDot === trimmed.length - 1) return "";
  return trimmed.slice(lastDot + 1).toLowerCase();
}

/**
 * Validates a browser `File` against an allow-list and size limit.
 * Deliberately extension-based, not MIME-based: browsers report MIME type
 * inconsistently (or not at all) for 3D formats, so trusting `file.type`
 * alone would either reject valid files or accept mislabeled ones.
 */
export function validateSelectedFile(file: File, config: FileValidationConfig): FileValidationResult {
  const extension = normalizeExtension(file.name);

  if (!config.allowedExtensions.includes(extension as ThreeDFileExtension)) {
    return {
      valid: false,
      error: createSafeError("UNSUPPORTED_FORMAT", formatAllowedMessage(config.allowedExtensions)),
    };
  }

  if (file.size === 0) {
    return { valid: false, error: createSafeError("EMPTY_FILE") };
  }

  if (file.size > config.maxSizeBytes) {
    return { valid: false, error: createSafeError("FILE_TOO_LARGE", sizeLimitMessage(config.maxSizeBytes)) };
  }

  return { valid: true, extension: extension as ThreeDFileExtension };
}

function formatAllowedMessage(allowed: ThreeDFileExtension[]): string {
  return `Supported formats: ${allowed.map((ext) => ext.toUpperCase()).join(", ")}.`;
}

function sizeLimitMessage(maxSizeBytes: number): string {
  const mb = Math.round(maxSizeBytes / (1024 * 1024));
  return `This tool currently supports files up to ${mb} MB.`;
}
